import * as vscode from 'vscode';
import { LMStudioProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
	console.log('LM Studio Adapter extension is now active!');

	const provider = new LMStudioProvider();
	const disposable = vscode.lm.registerLanguageModelChatProvider('lm-studio', provider);
	context.subscriptions.push(disposable);

	// Register the refresh command
	const refreshCommand = vscode.commands.registerCommand('lm-studio-adapter.refreshModels', () => provider.refreshModels());
	context.subscriptions.push(refreshCommand);
}

export function deactivate() {}

