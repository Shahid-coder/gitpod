/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import EventEmitter from 'events';
import React from 'react';
import { Terminal, ITerminalOptions, ITheme } from 'xterm';
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css';
import { DisposableCollection, GitpodServer } from '@gitpod/gitpod-protocol';

export interface WorkspaceLogsProps {
  logsEmitter: EventEmitter;
  errorMessage?: string;
}

export interface WorkspaceLogsState {
}

export default class WorkspaceLogs extends React.Component<WorkspaceLogsProps, WorkspaceLogsState> {
  protected xTermParentRef: React.RefObject<HTMLDivElement>;
  protected terminal: Terminal | undefined;
  protected fitAddon: FitAddon | undefined;

  constructor(props: WorkspaceLogsProps) {
    super(props);
    this.xTermParentRef = React.createRef();
  }

  private readonly toDispose = new DisposableCollection();
  componentDidMount() {
    const element = this.xTermParentRef.current;
    if (element === null) {
      return;
    }
    const theme: ITheme = {};
    const options: ITerminalOptions = {
      cursorBlink: false,
      disableStdin: true,
      fontSize: 14,
      theme,
      scrollback: 9999999,
    };
    this.terminal = new Terminal(options);
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(element);
    this.props.logsEmitter.on('logs', logs => {
      if (this.fitAddon && this.terminal && logs) {
        this.terminal.write(logs);
      }
    });
    this.toDispose.push(this.terminal);
    this.fitAddon.fit();

    // Fit terminal on window resize (debounced)
    let timeout: NodeJS.Timeout | undefined;
    const onWindowResize = () => {
      clearTimeout(timeout!);
      timeout = setTimeout(() => this.fitAddon!.fit(), 20);
    };
    window.addEventListener('resize', onWindowResize);
    this.toDispose.push({
      dispose: () => {
        clearTimeout(timeout!);
        window.removeEventListener('resize', onWindowResize);
      }
    });
  }

  componentDidUpdate() {
    if (this.terminal && this.props.errorMessage) {
      this.terminal.write(`\n\u001b[38;5;196m${this.props.errorMessage}\u001b[0m`);
    }
  }

  componentWillUnmount() {
    this.toDispose.dispose();
  }

  render() {
    return <div className="mt-6 h-72 w-11/12 lg:w-3/5 rounded-xl bg-black p-6">
      <div className="h-full w-full" ref={this.xTermParentRef}></div>
    </div>;
  }
}

export function watchHeadlessLogs(server: GitpodServer, instanceId: string, onLog: (chunk: string) => void, checkIsDone: () => Promise<void> | void): DisposableCollection {
  const disposables = new DisposableCollection();

  const startWatchingLogs = async () => {
    await checkIsDone();

    const retry = async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
      startWatchingLogs();
    };

    try {
      const logSources = await server.getHeadlessLog(instanceId);
      // TODO[gpl] Only listening on first stream for now
      const streamIds = Object.keys(logSources.streams);
      if (streamIds.length < 1) {
        await retry();
        return;
      }
      const streamUrl = logSources.streams[streamIds[0]];
      console.log("fetching from streamUrl: " + streamUrl);
      const response = await fetch(streamUrl, {
        method: 'GET',
        cache: 'no-cache',
        credentials: 'include',
        keepalive: true
      });
      const reader = response.body?.getReader();
      if (!reader) {
        await retry();
        return;
      }
      disposables.push({ dispose: () => reader.cancel() });

      const decoder = new TextDecoder('utf-8');
      let chunk = await reader.read();
      while (!chunk.done) {
        const chunkStr = decoder.decode(chunk.value, { stream: true });
        if (chunkStr === "Request Timeout") {
          await retry();
          return;
        }
        onLog(chunkStr);
        chunk = await reader.read();
      }

      await checkIsDone();
    } catch(err) {
      console.debug("error while listening to headless logs", err);
    }
  };
  startWatchingLogs();

  return disposables;
}