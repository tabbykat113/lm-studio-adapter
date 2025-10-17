import { LLMInfo, LMStudioClient, rawFunctionTool, FunctionToolCallRequest, ToolCallContext, ChatMessagePartToolCallRequestData, ChatMessagePartToolCallResultData, ChatMessageData, ChatMessagePartTextData, ChatHistoryData, LLMTool } from '@lmstudio/sdk';
import * as vscode from 'vscode';

export class LMStudioProvider implements vscode.LanguageModelChatProvider {
    private client?: LMStudioClient;
    private _wsUrl?: string;
    private cachedModels: LLMInfo[] = [];
    private _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    constructor() {
        this.refreshModels();
    }

    private ensureClient(): LMStudioClient {
        const config = vscode.workspace.getConfiguration('lmStudioAdapter');
        const wsUrl = config.get<string>('apiUrl') || 'ws://localhost:1234';
        if (!this.client || this._wsUrl !== wsUrl) {
            this._wsUrl = wsUrl;
            this.client = new LMStudioClient({ baseUrl: wsUrl });
        }
        return this.client;
    }

    public handleConfigurationChange(): void {
        this.refreshModels();
    }

    async refreshModels(): Promise<void> {
        try {
            const client = this.ensureClient();
            this.cachedModels = (await client.system.listDownloadedModels()).filter(model => model.type === 'llm');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch models: ${error instanceof Error ? error.message : 'Unknown error'}`);
            this.cachedModels = [];
        } finally {
            this._onDidChangeLanguageModelChatInformation.fire();
        }
    }

    provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
        return this.cachedModels.map(model => ({
            id: model.modelKey,
            name: model.displayName,
            family: 'llama',
            version: '1.0.0',
            maxInputTokens: model.maxContextLength - 2000,
            maxOutputTokens: 2000,
            capabilities: {
                imageInput: model.vision,
                toolCalling: model.trainedForToolUse,
            }
        }));
    }

    private _constructChatHistory(messages: readonly vscode.LanguageModelChatRequestMessage[]): ChatHistoryData {
        const chatHistory = messages.map(msg => {
            let role: 'assistant' | 'user' | 'system' | 'tool' = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';

            // If the message contains a tool result part, set role to 'tool'
            if (msg.content.some(part => part instanceof vscode.LanguageModelToolResultPart)) {
                role = 'tool';
            }

            const parts = msg.content.map(part => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    return { type: 'text' as const, text: part.value } as ChatMessagePartTextData;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    return {
                        type: 'toolCallRequest' as const,
                        toolCallRequest: {
                            type: 'function' as const,
                            id: part.callId,
                            name: part.name,
                            arguments: part.input as FunctionToolCallRequest['arguments'],
                        }
                    } as ChatMessagePartToolCallRequestData;
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    return {
                        type: 'toolCallResult' as const,
                        toolCallId: part.callId,
                        content: part.content.map(part => {
                            if (part instanceof vscode.LanguageModelTextPart) {
                                return part.value;
                            }
                            return '';
                        }).join(''),
                    } as ChatMessagePartToolCallResultData;
                }
                return { type: 'text' as const, text: '' } as ChatMessagePartTextData;
            });

            if (role === 'user') {
                return {
                    role: "user" as const,
                    content: parts as Array<ChatMessagePartTextData>
                };
            } else if (role === 'assistant') {
                return {
                    role: "assistant" as const,
                    content: parts as Array<ChatMessagePartTextData | ChatMessagePartToolCallRequestData>
                };
            } else if (role === 'tool') {
                return {
                    role: "tool" as const,
                    content: parts as Array<ChatMessagePartToolCallResultData>
                };
            }
        });

        return { messages: chatHistory } as ChatHistoryData;
    }

    async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
        const client = this.ensureClient();
        if (!client) {
            progress.report(new vscode.LanguageModelTextPart(`📡 Failed to connect to LM Studio. Please ensure the server is running and the API URL is correct.`));
            return;
        }
        const llmModel = await client.llm.model(model.id);

        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const llmChatHistory = this._constructChatHistory(messages);

        const response = llmModel.respond(llmChatHistory, {
            maxTokens: options.modelOptions?.maxTokens || 2000,
            signal: abortController.signal,
            rawTools: {
                type: "toolArray",
                tools:
                    options.tools?.map(tool => {
                        return {
                            type: "function",
                            function: {
                                name: tool.name,
                                description: tool.description,
                                parameters: tool.inputSchema
                            }
                        } as LLMTool;
                    }) || [],
            },
            onPredictionFragment(fragment) {
                // Ignore reasoning fragments
                if (fragment.reasoningType === 'none') {
                    progress.report(new vscode.LanguageModelTextPart(fragment.content));
                }
            },
            onToolCallRequestEnd(callId, info) {
                const toolCallPart = new vscode.LanguageModelToolCallPart(callId.toString(), info.toolCallRequest.name, info.toolCallRequest.arguments ?? {});
                progress.report(toolCallPart);
            }
        });

        try {
            await response;
        } catch (error) {
            if (!token.isCancellationRequested) {
                // Re-throwing the error will make it show up in the chat window as an error.
                // This is a good fallback for unexpected errors from the respond() call.
                throw error;
            }
        }
    }

    async provideTokenCount(model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
        const client = this.ensureClient();
        if (!client) {
            throw new Error(`Failed to connect to LM Studio. Please ensure the server is running and the API URL is correct.`);
        }

        const llmModel = await client.llm.model(model.id);

        // Note: LM Studio SDK does not provide a method to count tool call tokens, so we only count text parts here.
        const content = typeof text === 'string' ? text : text.content.map(part => {
            if (part instanceof vscode.LanguageModelTextPart) {
                return part.value;
            }
            return '';
        }).join('');

        return llmModel.countTokens(content);
    }
}
