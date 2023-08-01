/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
// import * as nls from 'vscode-nls'
import { VueWebview } from '../../../webviews/main'
import { isCloud9 } from '../../../shared/extensionUtilities'
import { ChildProcess } from '../../../shared/utilities/childProcess'

// const localize = nls.loadMessageBundle()

export class WeaverbirdChatWebview extends VueWebview {
    public readonly id = 'configureChat'
    public readonly source = 'src/weaverbird/vue/chat/index.js'

    public constructor() {
        // private readonly _client: codeWhispererClient // would be used if we integrate with codewhisperer
        super()
    }

    public init() {
        // history could come from a previous chat session if neccessary
        return {
            history: [],
        }
    }

    // Instrument the client sending here
    public async send(msg: string): Promise<string | undefined> {
        console.log(msg)

        const workspaceFolders = vscode.workspace.workspaceFolders
        if (workspaceFolders === undefined || workspaceFolders.length === 0) {
            throw new Error('Could not find workspace folder')
        }

        // We might need to pipe in the previous history here so we need to store that somewhere in the class
        const result = await new ChildProcess(
            '/usr/local/bin/python3',
            ['/Volumes/workplace/weaverbird-poc/.codecatalyst/llm/claude.py', '--query', msg],
            {
                spawnOptions: {
                    shell: '/bin/zsh',
                    // TODO add better detection for the workspace path because it can technically be in any number of workspaces
                    cwd: workspaceFolders[0].uri.fsPath,
                },
            }
        ).run({
            onStdout: text => console.log(`hey-claude: ${text}`),
            onStderr: text => console.log(`hey-claude: ${text}`),
        })

        if (result.error) {
            console.log(result.stderr)
            return Promise.resolve('Unable to interact with hey-claude')
        }

        return result.stdout
    }
}

const Panel = VueWebview.compilePanel(WeaverbirdChatWebview)
let activePanel: InstanceType<typeof Panel> | undefined

const View = VueWebview.compileView(WeaverbirdChatWebview)
let activeView: InstanceType<typeof View> | undefined

export async function showChat(ctx: vscode.ExtensionContext): Promise<void> {
    activePanel ??= new Panel(ctx)
    await activePanel.show({
        title: 'Weaverbird Chat', // TODO localize
        viewColumn: isCloud9() ? vscode.ViewColumn.One : vscode.ViewColumn.Active,
    })
}

export async function registerChatView(ctx: vscode.ExtensionContext): Promise<void> {
    activeView ??= new View(ctx)
    activeView.register({
        title: 'Weaverbird Chat',
    })
}
