# LM Studio Adapter for VS Code

This extension integrates [LM Studio](https://lmstudio.ai/) with Visual Studio Code's chat feature, allowing you to use your locally hosted language models within the editor's native chat interface.

## Features

*   **Seamless Integration:** Use your LM Studio models directly in the VS Code chat panel.
*   **Model Selection:** Automatically lists and makes available all downloaded LLMs from your LM Studio instance.
*   **Tool Calling Support:** Supports tool calling capabilities if your model is trained for it.
*   **Manual Refresh:** A command to manually refresh the list of available models.

## Requirements

You must have LM Studio running with the server started. By default, the extension will attempt to connect to `ws://localhost:1234`.

## Extension Settings

This extension contributes the following settings:

*   `lmStudioAdapter.apiUrl`: The WebSocket URL for the LM Studio API.
    *   **Default:** `ws://localhost:1234`

## Usage

1.  Start LM Studio server.
2.  In VS Code, open the Chat panel.
3.  Click the model selection dropdown and choose one of your LM Studio models.
4.  Start chatting!

## Commands

*   `LM Studio: Refresh Models List`: Manually triggers a refresh of the available models from LM Studio.

## Known Issues

*This section is a placeholder for known issues.*

## Release Notes

*This section is a placeholder for release notes.*