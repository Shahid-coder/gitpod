/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import EventEmitter from "events";
import React, { useEffect, Suspense } from "react";
import { DisposableCollection, WorkspaceInstance, WorkspaceImageBuild, Workspace, WithPrebuild } from "@gitpod/gitpod-protocol";
import { HeadlessLogEvent } from "@gitpod/gitpod-protocol/lib/headless-workspace-log";
import { ErrorCodes } from "@gitpod/gitpod-protocol/lib/messaging/error";
import PendingChangesDropdown from "../components/PendingChangesDropdown";
import { getGitpodService, gitpodHostUrl } from "../service/service";
import { StartPage, StartPhase, StartWorkspaceError } from "./StartPage";

const WorkspaceLogs = React.lazy(() => import('./WorkspaceLogs'));

export interface StartWorkspaceProps {
  workspaceId: string;
}

export interface StartWorkspaceState {
  startedInstanceId?: string;
  workspaceInstance?: WorkspaceInstance;
  workspace?: Workspace;
  hasImageBuildLogs?: boolean;
  hasLatestSuccessfulImage?: boolean;
  error?: StartWorkspaceError;
}

export default class StartWorkspace extends React.Component<StartWorkspaceProps, StartWorkspaceState> {

  constructor(props: StartWorkspaceProps) {
    super(props);
    this.state = {};
  }

  private readonly toDispose = new DisposableCollection();
  componentWillMount() {
    if (this.runsInIFrame()) {
      const setStateEventListener = (event: MessageEvent) => {
        if (event.data.type === 'setState' && 'state' in event.data && typeof event.data['state'] === 'object') {
          if (event.data.state.ideFrontendFailureCause) {
            const error = { message: event.data.state.ideFrontendFailureCause };
            this.setState({ error });
          }
        }
      }
      window.addEventListener('message', setStateEventListener, false);
      this.toDispose.push({
        dispose: () => window.removeEventListener('message', setStateEventListener)
      });
    }

    try {
      this.toDispose.push(getGitpodService().registerClient(this));
    } catch (error) {
      console.error(error);
      this.setState({ error });
    }

    this.startWorkspace();
  }

  componentWillUnmount() {
    this.toDispose.dispose();
  }

  async startWorkspace(restart = false, force: undefined | "default" | "latest" = undefined) {
    const state = this.state;
    if (state) {
      if (!restart && (state.startedInstanceId /* || state.errorMessage */)) {
        // We stick with a started instance until we're explicitly told not to
        return;
      }
    }

    const { workspaceId } = this.props;
    try {
      const result = await getGitpodService().server.startWorkspace(workspaceId, { forceDefaultImage: force === "default", forceLatestSuccessfulImage: force === "latest" });
      if (!result) {
        throw new Error("No result!");
      }
      console.log("/start: started workspace instance: " + result.instanceID);
      // redirect to workspaceURL if we are not yet running in an iframe
      if (!this.runsInIFrame() && result.workspaceURL) {
        this.redirectTo(result.workspaceURL);
        return;
      }
      this.setState({ startedInstanceId: result.instanceID });
      // Explicitly query state to guarantee we get at least one update
      // (needed for already started workspaces, and not hanging in 'Starting ...' for too long)
      this.fetchWorkspaceInfo();
    } catch (error) {
      console.error(error);
      if (typeof error === 'string') {
        error = { message: error };
      }
      if (error?.code === ErrorCodes.USER_BLOCKED) {
        this.redirectTo(gitpodHostUrl.with({ pathname: '/blocked' }).toString());
        return;
      }
      this.setState({ error });
    }
  }

  async fetchWorkspaceInfo() {
    const { workspaceId } = this.props;
    try {
      const info = await getGitpodService().server.getWorkspace(workspaceId);
      if (info.latestInstance) {
        this.setState({
          workspace: info.workspace
        });
        this.onInstanceUpdate(info.latestInstance);
      }
    } catch (error) {
      console.error(error);
      this.setState({ error });
    }
  }

  notifyDidOpenConnection() {
    this.fetchWorkspaceInfo();
  }

  async onInstanceUpdate(workspaceInstance: WorkspaceInstance) {
    const startedInstanceId = this.state?.startedInstanceId;
    if (workspaceInstance.workspaceId !== this.props.workspaceId || startedInstanceId !== workspaceInstance.id) {
      return;
    }

    await this.ensureWorkspaceAuth(workspaceInstance.id);

    // Redirect to workspaceURL if we are not yet running in an iframe.
    // It happens this late if we were waiting for a docker build.
    if (!this.runsInIFrame() && workspaceInstance.ideUrl) {
      this.redirectTo(workspaceInstance.ideUrl);
      return;
    }

    if (workspaceInstance.status.phase === 'preparing') {
      this.setState({ hasImageBuildLogs: true });
    }

    let error: StartWorkspaceError | undefined;
    if (workspaceInstance.status.conditions.failed) {
      error = { message: workspaceInstance.status.conditions.failed };
    }

    // Successfully stopped and headless: the prebuild is done, let's try to use it!
    if (!error && workspaceInstance.status.phase === 'stopped' && this.state.workspace?.type !== 'regular') {
      const contextUrl = this.state.workspace?.contextURL.replace('prebuild/', '')!;
      this.redirectTo(gitpodHostUrl.withContext(contextUrl).toString());
    }

    this.setState({ workspaceInstance, error });
  }

  async ensureWorkspaceAuth(instanceID: string) {
    if (!document.cookie.includes(`${instanceID}_owner_`)) {
      const authURL = gitpodHostUrl.asWorkspaceAuth(instanceID);
      const response = await fetch(authURL.toString());
      if (response.redirected) {
        this.redirectTo(response.url);
        return;
      }
      if (!response.ok) {
        // getting workspace auth didn't work as planned - redirect
        this.redirectTo(authURL.asWorkspaceAuth(instanceID, true).toString());
        return;
      }
    }
  }

  redirectTo(url: string) {
    if (this.runsInIFrame()) {
        window.parent.postMessage({ type: 'relocate', url }, '*');
    } else {
        window.location.href = url;
    }
  }

  runsInIFrame() {
    return window.top !== window.self;
  }

  render() {
    const { error } = this.state;
    const isHeadless = this.state.workspace?.type !== 'regular';
    const isPrebuilt = WithPrebuild.is(this.state.workspace?.context);
    let phase = StartPhase.Preparing;
    let title = undefined;
    let statusMessage = !!error ? undefined : <p className="text-base text-gray-400">Preparing workspace …</p>;

    switch (this.state?.workspaceInstance?.status.phase) {
      // unknown indicates an issue within the system in that it cannot determine the actual phase of
      // a workspace. This phase is usually accompanied by an error.
      case "unknown":
        break;

      // Preparing means that we haven't actually started the workspace instance just yet, but rather
      // are still preparing for launch. This means we're building the Docker image for the workspace.
      case "preparing":
        return <ImageBuildView workspaceId={this.state.workspaceInstance.workspaceId} />;

      // Pending means the workspace does not yet consume resources in the cluster, but rather is looking for
      // some space within the cluster. If for example the cluster needs to scale up to accomodate the
      // workspace, the workspace will be in Pending state until that happened.
      case "pending":
        phase = StartPhase.Preparing;
        statusMessage = <p className="text-base text-gray-400">Allocating resources …</p>;
        break;

      // Creating means the workspace is currently being created. That includes downloading the images required
      // to run the workspace over the network. The time spent in this phase varies widely and depends on the current
      // network speed, image size and cache states.
      case "creating":
        phase = StartPhase.Creating;
        statusMessage = <p className="text-base text-gray-400">Pulling container image …</p>;
        break;

      // Initializing is the phase in which the workspace is executing the appropriate workspace initializer (e.g. Git
      // clone or backup download). After this phase one can expect the workspace to either be Running or Failed.
      case "initializing":
        phase = StartPhase.Starting;
        statusMessage = <p className="text-base text-gray-400">{isPrebuilt ? 'Loading prebuild …' : 'Initializing content …'}</p>;
        break;

      // Running means the workspace is able to actively perform work, either by serving a user through Theia,
      // or as a headless workspace.
      case "running":
        if (isHeadless) {
          return <HeadlessWorkspaceView workspaceId={this.state.workspaceInstance.workspaceId} />;
        }
        phase = StartPhase.Running;
        statusMessage = <p className="text-base text-gray-400">Opening IDE …</p>;
        break;

      // Interrupted is an exceptional state where the container should be running but is temporarily unavailable.
      // When in this state, we expect it to become running or stopping anytime soon.
      case "interrupted":
        phase = StartPhase.Running;
        statusMessage = <p className="text-base text-gray-400">Checking workspace …</p>;
        break;

      // Stopping means that the workspace is currently shutting down. It could go to stopped every moment.
      case "stopping":
        if (isHeadless) {
          return <HeadlessWorkspaceView workspaceId={this.state.workspaceInstance.workspaceId} />;
        }
        phase = StartPhase.Stopping;
        statusMessage = <div>
          <div className="flex space-x-3 items-center text-left rounded-xl m-auto px-4 h-16 w-72 mt-4 bg-gray-100 dark:bg-gray-800">
            <div className="rounded-full w-3 h-3 text-sm bg-gitpod-kumquat">&nbsp;</div>
            <div>
              <p className="text-gray-700 dark:text-gray-200 font-semibold">{this.state.workspaceInstance.workspaceId}</p>
              <a target="_parent" href={this.state.workspace?.contextURL}><p className="w-56 truncate hover:text-blue-600 dark:hover:text-blue-400" >{this.state.workspace?.contextURL}</p></a>
            </div>
          </div>
          <div className="mt-10 flex justify-center">
            <a target="_parent" href={gitpodHostUrl.asDashboard().toString()}><button className="secondary">Go to Dashboard</button></a>
          </div>
        </div>;
        break;

      // Stopped means the workspace ended regularly because it was shut down.
      case "stopped":
        phase = StartPhase.Stopped;
        if (this.state.hasImageBuildLogs) {
          const restartWithDefaultImage = (event: React.MouseEvent) => {
            (event.target as HTMLButtonElement).disabled = true;
            this.startWorkspace(true, "default");
          }
          this.state.hasLatestSuccessfulImage === undefined &&
            getGitpodService().server.hasWorkspaceImageIgnoringDockerfileFrom(this.props.workspaceId).then(hasLatestSuccessfulImage => this.setState({ hasLatestSuccessfulImage }));
          const restartWithLatestSuccessfulImage = this.state.hasLatestSuccessfulImage ?
            (event: React.MouseEvent) => {
              (event.target as HTMLButtonElement).disabled = true;
              this.startWorkspace(true, "latest");
            } : undefined;
          return <ImageBuildView
            workspaceId={this.state.workspaceInstance.workspaceId}
            onStartWithDefaultImage={restartWithDefaultImage}
            onRestartWithLatestSuccessfulImage={restartWithLatestSuccessfulImage}
            phase={phase}
            error={error}
          />;
        }
        if (!isHeadless && this.state.workspaceInstance.status.conditions.timeout) {
          title = 'Timed Out';
        }
        statusMessage = <div>
          <div className="flex space-x-3 items-center text-left rounded-xl m-auto px-4 h-16 w-72 mt-4 mb-2 bg-gray-100 dark:bg-gray-800">
            <div className="rounded-full w-3 h-3 text-sm bg-gray-300">&nbsp;</div>
            <div>
              <p className="text-gray-700 dark:text-gray-200 font-semibold">{this.state.workspaceInstance.workspaceId}</p>
              <a target="_parent" href={this.state.workspace?.contextURL}><p className="w-56 truncate hover:text-blue-600 dark:hover:text-blue-400" >{this.state.workspace?.contextURL}</p></a>
            </div>
          </div>
          <PendingChangesDropdown workspaceInstance={this.state.workspaceInstance} />
          <div className="mt-10 justify-center flex space-x-2">
            <a target="_parent" href={gitpodHostUrl.asDashboard().toString()}><button className="secondary">Go to Dashboard</button></a>
            <a target="_parent" href={gitpodHostUrl.asStart(this.state.workspaceInstance?.workspaceId).toString()}><button>Open Workspace</button></a>
          </div>
        </div>;
        break;
    }

    return <StartPage phase={phase} error={error} title={title}>
      {statusMessage}
    </StartPage>;
  }
}

interface ImageBuildViewProps {
  workspaceId: string;
  onStartWithDefaultImage?: (event: React.MouseEvent) => void;
  onRestartWithLatestSuccessfulImage?: (event: React.MouseEvent) => void;
  phase?: StartPhase;
  error?: StartWorkspaceError;
}

function ImageBuildView(props: ImageBuildViewProps) {
  const logsEmitter = new EventEmitter();

  useEffect(() => {
    const service = getGitpodService();
    const watchBuild = () => service.server.watchWorkspaceImageBuildLogs(props.workspaceId);
    watchBuild();

    const toDispose = service.registerClient({
      notifyDidOpenConnection: () => watchBuild(),
      onWorkspaceImageBuildLogs: (info: WorkspaceImageBuild.StateInfo, content?: WorkspaceImageBuild.LogContent) => {
        if (!content) {
          return;
        }
        logsEmitter.emit('logs', content.text);
      },
    });

    return function cleanup() {
      toDispose.dispose();
    };
  }, []);

  return <StartPage title="Building Image" phase={props.phase}>
    <Suspense fallback={<div />}>
      <WorkspaceLogs logsEmitter={logsEmitter} errorMessage={props.error?.message} />
    </Suspense>
    <div className="mt-10 justify-center flex space-x-2">
      {!!props.onRestartWithLatestSuccessfulImage && <button className="mt-6 secondary" onClick={props.onRestartWithLatestSuccessfulImage}>Continue with Latest Successfully Built Image</button>}
      {!!props.onStartWithDefaultImage && <button className="mt-6 secondary" onClick={props.onStartWithDefaultImage}>Continue with Default Image</button>}
    </div>
  </StartPage>;
}

function HeadlessWorkspaceView(props: { workspaceId: string }) {
  const logsEmitter = new EventEmitter();

  useEffect(() => {
    const service = getGitpodService();
    const watchHeadlessWorkspace = () => service.server.watchHeadlessWorkspaceLogs(props.workspaceId);;
    watchHeadlessWorkspace();

    const toDispose = service.registerClient({
      notifyDidOpenConnection: () => watchHeadlessWorkspace(),
      onHeadlessWorkspaceLogs(event: HeadlessLogEvent): void {
        logsEmitter.emit('logs', event.text);
      },
    });

    return function cleanup() {
      toDispose.dispose();
    };
  }, []);

  return <StartPage title="Prebuild in Progress">
    <Suspense fallback={<div />}>
      <WorkspaceLogs logsEmitter={logsEmitter}/>
    </Suspense>
  </StartPage>;
}
