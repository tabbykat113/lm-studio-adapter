import { LLMInfo, LMStudioClient, rawFunctionTool, FunctionToolCallRequest, ToolCallContext, ChatMessagePartToolCallRequestData, ChatMessagePartToolCallResultData, ChatMessageData, ChatMessagePartTextData, ChatHistoryData } from '@lmstudio/sdk';
import * as vscode from 'vscode';

export class LMStudioProvider implements vscode.LanguageModelChatProvider {
    private cachedModels: LLMInfo[] = [];
    private _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    constructor() {        
        // Initial refresh
        this.refreshModels();
    }

    async refreshModels(): Promise<void> {
        const config = vscode.workspace.getConfiguration('lmStudioAdapter');
        const wsUrl = config.get<string>('apiUrl') || 'ws://localhost:1234';
        const client = new LMStudioClient({ baseUrl: wsUrl });

        try {
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

    async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
        const config = vscode.workspace.getConfiguration('lmStudioAdapter');
        const wsUrl = config.get<string>('apiUrl') || 'ws://localhost:1234';
        const client = new LMStudioClient({ baseUrl: wsUrl });
        const llmModel = await client.llm.model(model.id);

        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        // TODO: Rewrite and convert to private method
        const chatHistory = messages.map(msg => {
            let role: 'assistant' | 'user' | 'system' | 'tool' = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';

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
                    role = 'tool';
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

        const llmChatHistory = { messages: chatHistory } as ChatHistoryData;
        
        const toolNameMappings: { [key: string]: string } = {
            'semantic_search': 'copilot_searchCodebase',
            'list_code_usages': 'copilot_listCodeUsages',
            'get_vscode_api': 'copilot_getVSCodeAPI',
            'file_search': 'copilot_findFiles',
            'grep_search': 'copilot_findTextInFiles',
            'read_file': 'copilot_readFile',
            'list_dir': 'copilot_listDirectory',
            'get_errors': 'copilot_getErrors',
            'get_changed_files': 'copilot_getChangedFiles',
            'test_failure': 'copilot_testFailure',
            'create_new_workspace': 'copilot_createNewWorkspace',
            'get_project_setup_info': 'copilot_getProjectSetupInfo',
            'install_extension': 'copilot_installExtension',
            'run_vscode_command': 'copilot_runVscodeCommand',
            'create_new_jupyter_notebook': 'copilot_createNewJupyterNotebook',
            'insert_edit_into_file': 'copilot_insertEdit',
            'create_file': 'copilot_createFile',
            'create_directory': 'copilot_createDirectory',
            'open_simple_browser': 'copilot_openSimpleBrowser',
            'replace_string_in_file': 'copilot_replaceString',
            'edit_notebook_file': 'copilot_editNotebook',
            'run_notebook_cell': 'copilot_runNotebookCell',
            'read_notebook_cell_output': 'copilot_readNotebookCellOutput',
            'fetch_webpage': 'copilot_fetchWebPage',
            'get_search_view_results': 'copilot_getSearchResults',
            'github_repo': 'copilot_githubRepo',
        };

        const availableToolNames = new Set(vscode.lm.tools.map(t => t.name));
        const callableToolMap = new Map<string, string>();

        for (const tool of options.tools || []) {
            if (availableToolNames.has(tool.name)) {
                callableToolMap.set(tool.name, tool.name);
            } else {
                const mappedName = toolNameMappings[tool.name];
                if (mappedName && availableToolNames.has(mappedName)) {
                    callableToolMap.set(tool.name, mappedName);
                }
            }
        }

        const finalToolsForModel = options.tools?.filter(tool => callableToolMap.has(tool.name)) || [];

        const tools = finalToolsForModel.map(vscodeTool => {
            return rawFunctionTool({
                name: vscodeTool.name,
                description: vscodeTool.description,
                parametersJsonSchema: vscodeTool.inputSchema ?? { type: 'object', properties: {}, required: [] },
                implementation: async (params: Record<string, unknown>, ctx: ToolCallContext) => {
                    const callableName = callableToolMap.get(vscodeTool.name);
                    if (!callableName) {
                        throw new Error(`Tool ${vscodeTool.name} is not available.`);
                    }
                    console.log(`Invoking tool: ${vscodeTool.name} (mapped to: ${callableName}) with params:`, params);
                    const result = await vscode.lm.invokeTool(callableName, {
                        toolInvocationToken: undefined,
                        input: params
                    });
                    return result;
                },
            });
        }) ?? [];

        const response = llmModel.act(llmChatHistory, tools, {
            maxTokens: options.modelOptions?.maxTokens || 2000,
            signal: abortController.signal,
            onPredictionFragment(fragment) {
                // Ignore reasoning fragments
                if (fragment.reasoningType === 'none') {
                    progress.report(new vscode.LanguageModelTextPart(fragment.content));
                }
            },
            onMessage: (message) => {
                // Report tool calls
                const toolCalls = message.getToolCallRequests();
                for (const call of toolCalls) {
                    progress.report(new vscode.LanguageModelToolCallPart(call.id || 'none', call.name, call.arguments || {}));
                }
                // Report tool results
                const results = message.getToolCallResults();
                for (const result of results) {
                    progress.report(new vscode.LanguageModelToolResultPart(result.toolCallId || 'none', [result.content]));
                }
            }
        });

        try {
            await response;
        } catch (error) {
            if (!token.isCancellationRequested) {
                throw error;
            }
        }
    }

    async provideTokenCount(model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
        const config = vscode.workspace.getConfiguration('lmStudioAdapter');
        const wsUrl = config.get<string>('apiUrl') || 'ws://localhost:1234';
        const client = new LMStudioClient({ baseUrl: wsUrl });
        const llmModel = await client.llm.model(model.id);

        // NOTE: Inaccurate for tool calls, needs rewrite
        const content = typeof text === 'string' ? text : text.content.map(part => {
            if (part instanceof vscode.LanguageModelTextPart) {
                return part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                return `${part.name}(${JSON.stringify(part.input)})`;
            }
            return '';
        }).join('');

        return llmModel.countTokens(content);
    }
}