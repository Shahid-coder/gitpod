/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { useEffect, useState } from "react";
import Modal from "./components/Modal";
import { getGitpodService, gitpodHostUrl } from "./service/service";

export default function NewProject() {

    const [provider] = useState<"github.com">("github.com");
    const [accounts, setAccounts] = useState<string[]>([]);
    const [selectedAccount, setSelectedAccount] = useState<string | undefined>(undefined);
    const [repositories, setRepositories] = useState<string[]>([]);

    useEffect(() => {
        (async () => {
            const accounts = await getGitpodService().server.getProviderAccounts(provider);
            setAccounts(accounts);
            setSelectedAccount(accounts[0]);
        })();
    }, []);

    useEffect(() => {
        updateAccounts();
    }, [selectedAccount]);

    const updateAccounts = async () => {
        if (selectedAccount) {
            const repositories = await getGitpodService().server.getProviderAccountRepositories(provider, selectedAccount);
            setRepositories(repositories);
        }
    }

    const reconfigure = () => {
        openReconfigureWindow({
            account: selectedAccount, onSuccess: p => {
                updateAccounts();
            }
        });
    }

    return (<div>
        <Modal visible={true} onClose={() => { }} closeable={false}>
            <h3 className="pb-2">Select Repository</h3>
            <div className="border-t border-b border-gray-200 dark:border-gray-800 mt-2 -mx-6 px-6 py-4">
                <select name="type" value={selectedAccount} className="w-full"
                    onChange={(e) => setSelectedAccount(e.target.value)}>
                    {accounts.map(a => (<option key={`account-${a}`} value={a}>{a}</option>))}
                </select>

                <div className="flex">

                </div>
            </div>
            <div className="flex justify-end mt-6 cursor-pointer">
                {repositories.length === 0 && (
                    <div onClick={e => reconfigure()}>
                        Missing Git repository? Reconfigure...
                    </div>
                )}
                {repositories.length > 0 && (
                    <ul>
                        {repositories.map(r => (<li key={`account-${r}`} value={r}>{r}</li>))}
                    </ul>
                )}
            </div>
        </Modal>
    </div>);

}

async function openReconfigureWindow(params: { account?: string, onSuccess: (p: any) => void }) {
    const { account, onSuccess } = params;
    let search = 'message=success';
    const returnTo = gitpodHostUrl.with({ pathname: 'complete-auth', search: search }).toString();
    const url = gitpodHostUrl.withApi({
        pathname: '/apps/github/reconfigure',
        search: `account=${account}&state=${encodeURIComponent(returnTo)}`
    }).toString();

    // Optimistically assume that the new window was opened.
    window.open(url, "gitpod-github-window", "width=800,height=800,status=yes,scrollbars=yes,resizable=yes");

    const eventListener = (event: MessageEvent) => {
        // todo: check event.origin

        const killWindow = () => {
            window.removeEventListener("message", eventListener);

            if (event.source && "close" in event.source && event.source.close) {
                console.log(`Received Window Result. Closing Window.`);
                event.source.close();
            }
        }

        if (typeof event.data === "string" && event.data.startsWith("success")) {
            killWindow();
            onSuccess && onSuccess(event.data);
        }
        if (typeof event.data === "string" && event.data.startsWith("error:")) {
            let error: string | { error: string, description?: string } = atob(event.data.substring("error:".length));
            try {
                const payload = JSON.parse(error);
                if (typeof payload === "object" && payload.error) {
                    error = { error: payload.error, description: payload.description };
                }
            } catch (error) {
                console.log(error);
            }

            killWindow();
            // onError && onError(error);
        }
    };
    window.addEventListener("message", eventListener);
}