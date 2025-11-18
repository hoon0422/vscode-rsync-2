'use strict';

import * as child from 'child_process';
import chokidar from 'chokidar';
import { debounce } from 'lodash';
import Rsync from 'rsync';
import {
    commands,
    Disposable,
    ExtensionContext,
    OutputChannel,
    QuickPickItem,
    StatusBarAlignment,
    StatusBarItem,
    window as vscWindow,
    workspace
} from 'vscode';
import { Config, Site } from './Config';

interface SyncOptions {
    down: boolean;
    dry: boolean;
}

interface CommandResult {
    success: boolean;
    code: number;
}

class RsyncExtension {
    private readonly outputChannel: OutputChannel;
    private readonly statusBar: StatusBarItem;
    private currentSync?: child.ChildProcess;
    private syncKilled: boolean = true;
    private disposables: Disposable[] = [];
    private currentSite: Site | null = null;

    constructor() {
        this.outputChannel = vscWindow.createOutputChannel('Sync-Rsync');
        this.statusBar = vscWindow.createStatusBarItem(StatusBarAlignment.Right, 1);
        this.statusBar.text = 'Rsync: $(info)';
        this.statusBar.command = 'sync-rsync.showSiteMenu';
        this.statusBar.show();
        this.outputChannel.appendLine('Sync-Rsync started');
    }

    private createStatusText(text: string): string {
        const siteName = this.currentSite?.name ?? this.currentSite?.remotePath ?? 'No Site';
        return `Rsync: ${siteName} - ${text}`;
    }

    private getConfig(): Config {
        return new Config(workspace.getConfiguration('sync-rsync'));
    }

    private async execute(config: Config, cmd: string, args: string[] = [], shell?: string): Promise<CommandResult> {
        return new Promise<CommandResult>((resolve) => {
            let error = false;
            this.outputChannel.appendLine(`> ${cmd} ${args.join(' ')}`);

            if (config.autoShowOutput) {
                this.outputChannel.show();
            }

            const showOutput = (data: Buffer): void => {
                this.outputChannel.append(data.toString());
            };

            try {
                if (process.platform === 'win32' && shell) {
                    args = ["'", cmd].concat(args, "'");
                    this.currentSync = child.spawn(`${shell} -c`, args, { stdio: 'pipe', shell: "cmd.exe" });
                } else if (process.platform === 'win32' && config.useWSL) {
                    args = [cmd].concat(args);
                    this.currentSync = child.spawn("wsl", args, { stdio: 'pipe', shell: "cmd.exe" });
                } else {
                    this.currentSync = child.spawn(cmd, args, { stdio: 'pipe', shell });
                }

                if (!this.currentSync) {
                    throw new Error('Failed to spawn process');
                }

                this.currentSync.on('error', (err: Error) => {
                    this.outputChannel.append(`ERROR > ${err.message}`);
                    error = true;
                    resolve({ success: false, code: 1 });
                });

                if (this.currentSync.stdout) {
                    this.currentSync.stdout.on('data', showOutput);
                }
                if (this.currentSync.stderr) {
                    this.currentSync.stderr.on('data', showOutput);
                }

                this.currentSync.on('close', (code) => {
                    if (!error) {
                        resolve({ success: code === 0, code: code ?? 1 });
                    }
                });
            } catch (err) {
                this.outputChannel.append(`ERROR > ${err instanceof Error ? err.message : String(err)}`);
                resolve({ success: false, code: 1 });
            }
        });
    }

    private async runSync(rsync: InstanceType<typeof Rsync>, paths: string[], site: Site, config: Config): Promise<CommandResult> {
        const syncStartTime = new Date();
        const isDryRun = rsync.isSet('n');
        this.outputChannel.appendLine(`\n${syncStartTime.toString()} ${isDryRun ? 'comparing' : 'syncing'}`);
        return this.execute(config, site.executable, rsync.args().concat(site.args).concat(paths), site.executableShell);
    }

    private async runCommand(site: Site, config: Config, command: string[]): Promise<CommandResult> {
        const [cmd, ...args] = command;
        return this.execute(config, cmd, args, site.executableShell);
    }

    private async syncSite(site: Site, config: Config, { down, dry }: SyncOptions): Promise<boolean> {
        if (down && site.upOnly) {
            this.outputChannel.appendLine(`\n${site.remotePath ?? 'Unknown'} is upOnly`);
            return true;
        }

        if (!down && site.downOnly) {
            this.outputChannel.appendLine(`\n${site.remotePath ?? 'Unknown'} is downOnly`);
            return true;
        }

        if (this.syncKilled) {
            return false;
        }

        if (!site.localPath) {
            vscWindow.showErrorMessage('Sync-Rsync: you must have a folder open or configured local');
            return false;
        }

        if (!site.remotePath) {
            vscWindow.showErrorMessage('Sync-Rsync: you must configure a remote');
            return false;
        }

        let rsync = new Rsync();
        const paths = down ? [site.remotePath, site.localPath] : [site.localPath, site.remotePath];

        if (dry) {
            rsync.dry();
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        site.options.forEach(option => rsync.set(...(option as [string, ...any[]])));

        rsync = rsync.flags(site.flags);

        if (config.showProgress) {
            rsync = rsync.progress();
        }

        if (site.include.length > 0) {
            rsync.include(site.include);
        }

        if (site.exclude.length > 0) {
            rsync.exclude(site.exclude);
        }

        if (site.shell) {
            rsync.shell(site.shell);
        }

        if (site.deleteFiles) {
            rsync.delete();
        }

        if (site.chmod) {
            rsync.chmod(site.chmod);
        }

        const runPrePost = async (command: string[] | undefined, tag: string): Promise<boolean> => {
            if (!command) {
                return true;
            }
            const result = await this.runCommand(site, config, command);
            if (!result.success) {
                vscWindow.showErrorMessage(`${tag} returned ${result.code}`);
            }
            return result.success;
        };

        let success = true;

        if (down) {
            if (site.preSyncDown) {
                success = await runPrePost(site.preSyncDown, 'preSyncDown');
            }
        } else {
            if (site.preSyncUp) {
                success = await runPrePost(site.preSyncUp, 'preSyncUp');
            }
        }

        if (success) {
            const result = await this.runSync(rsync, paths, site, config);
            success = result.success;

            if (success) {
                if (down) {
                    if (site.postSyncDown) {
                        success = await runPrePost(site.postSyncDown, 'postSyncDown');
                    }
                } else {
                    if (site.postSyncUp) {
                        success = await runPrePost(site.postSyncUp, 'postSyncUp');
                    }
                    if (site.afterSync) {
                        success = await runPrePost(site.afterSync, 'afterSync');
                        vscWindow.showInformationMessage('afterSync will be deprecated use postSyncUp');
                    }
                }
            } else {
                vscWindow.showErrorMessage(`rsync returned ${result.code}`);
            }
        }

        return success;
    }

    private async sync(config: Config, { down, dry }: SyncOptions): Promise<void> {
        if (!this.currentSite) {
            vscWindow.showErrorMessage('No site selected. Please select a site first.');
            return;
        }

        this.statusBar.color = 'mediumseagreen';
        this.statusBar.text = this.createStatusText('$(sync)');
        this.statusBar.command = 'sync-rsync.killSync';

        let success = true;
        this.syncKilled = false;

        success = await this.syncSite(this.currentSite, config, { down, dry });

        this.syncKilled = true;
        this.statusBar.command = 'sync-rsync.showSiteMenu';

        if (success) {
            if (config.autoHideOutput) {
                this.outputChannel.hide();
            }
            this.statusBar.color = undefined;
            this.statusBar.text = this.createStatusText('$(check)');
            if (config.notification) {
                vscWindow.showInformationMessage('Sync Completed');
            }
        } else {
            if (config.autoShowOutputOnError) {
                this.outputChannel.show();
            }
            this.statusBar.color = 'red';
            this.statusBar.text = this.createStatusText('$(alert)');
        }
    }

    private async syncFile(config: Config, file: string, down: boolean): Promise<void> {
        if (!this.currentSite) {
            vscWindow.showErrorMessage('No site selected. Please select a site first.');
            return;
        }

        this.statusBar.color = 'mediumseagreen';
        this.statusBar.text = this.createStatusText('$(sync)');
        this.statusBar.command = 'sync-rsync.killSync';

        let success = true;
        this.syncKilled = false;

        const paths = down ? [this.currentSite.remotePath + file, this.currentSite.localPath + file] : [this.currentSite.localPath + file, this.currentSite.remotePath + file];
        let rsync = new Rsync().flags(this.currentSite.flags);
        if (config.showProgress) {
            rsync = rsync.progress();
        }

        if (this.currentSite.include.length > 0) {
            rsync.include(this.currentSite.include);
        }

        if (this.currentSite.exclude.length > 0) {
            rsync.exclude(this.currentSite.exclude);
        }

        if (this.currentSite.shell) {
            rsync.shell(this.currentSite.shell);
        }

        if (this.currentSite.deleteFiles) {
            rsync.delete();
        }

        if (this.currentSite.chmod) {
            rsync.chmod(this.currentSite.chmod);
        }

        const result = await this.runSync(rsync, paths, this.currentSite, config);
        success = result.success;

        this.syncKilled = true;
        this.statusBar.command = 'sync-rsync.showSiteMenu';

        if (success) {
            if (config.autoHideOutput) {
                this.outputChannel.hide();
            }
            this.statusBar.color = undefined;
            this.statusBar.text = this.createStatusText('$(check)');
            if (config.notification) {
                vscWindow.showInformationMessage('File Sync Completed');
            }
        } else {
            if (config.autoShowOutputOnError) {
                this.outputChannel.show();
            }
            this.statusBar.color = 'red';
            this.statusBar.text = this.createStatusText('$(alert)');
        }
    }

    private watch(config: Config): void {
        if (config.watchGlobs.length === 0) {
            return;
        }

        const watcher = chokidar.watch(config.watchGlobs, {
            ignored: /(^|[/\\])\../,
            persistent: true
        });

        const debouncedSync = debounce(() => {
            this.sync(config, { down: false, dry: false });
        }, 1000);

        watcher.on('change', debouncedSync);
        this.disposables.push(new Disposable(() => {
            watcher.close();
            debouncedSync.cancel();
        }));
    }

    private syncSingle(config: Config, down: boolean): void {
        const sites = config.sites;
        if (sites.length === 0) {
            vscWindow.showErrorMessage('No sites configured');
            return;
        }

        if (sites.length === 1) {
            this.sync(config, { down, dry: false });
            return;
        }

        const items = sites.map(site => ({
            label: site.name ?? site.remotePath ?? 'Unknown Site',
            description: site.remotePath ?? '',
            site
        }));

        vscWindow.showQuickPick(items, {
            placeHolder: 'Select a site to sync'
        }).then(selected => {
            if (selected) {
                this.syncSite(selected.site, config, { down, dry: false });
            }
        });
    }

    private async showSiteMenu(): Promise<void> {
        const config = this.getConfig();
        const sites = config.sites;

        if (sites.length === 0) {
            vscWindow.showErrorMessage('No sites configured');
            return;
        }

        interface SiteQuickPickItem extends QuickPickItem {
            site: Site | null;
        }

        const items: SiteQuickPickItem[] = sites.map(site => ({
            label: site.name ?? site.remotePath ?? 'Unknown Site',
            description: site.remotePath ?? '',
            site
        }));

        // Add disconnect option if a site is selected
        if (this.currentSite) {
            items.unshift({
                label: '$(close) Disconnect',
                description: 'Disconnect from current site',
                site: null
            });
        }

        const selected = await vscWindow.showQuickPick<SiteQuickPickItem>(items, {
            placeHolder: 'Select a site or disconnect'
        });

        if (selected) {
            if (selected.site === null) {
                // Disconnect was selected
                this.currentSite = null;
                this.statusBar.text = this.createStatusText('$(info)');
                this.outputChannel.appendLine('Disconnected from site');
            } else {
                // A site was selected
                this.currentSite = selected.site;
                this.statusBar.text = this.createStatusText('$(info)');
                this.outputChannel.appendLine(`Connected to site: ${selected.label}`);
            }
        }
    }

    public activate(context: ExtensionContext): void {
        const syncUp = () => {
            if (!this.currentSite) {
                vscWindow.showErrorMessage('No site selected. Please select a site first.');
                return;
            }
            this.sync(this.getConfig(), { down: false, dry: false });
        };
        const syncDown = () => {
            if (!this.currentSite) {
                vscWindow.showErrorMessage('No site selected. Please select a site first.');
                return;
            }
            this.sync(this.getConfig(), { down: true, dry: false });
        };
        const compareUp = () => {
            if (!this.currentSite) {
                vscWindow.showErrorMessage('No site selected. Please select a site first.');
                return;
            }
            this.sync(this.getConfig(), { down: false, dry: true });
        };
        const compareDown = () => {
            if (!this.currentSite) {
                vscWindow.showErrorMessage('No site selected. Please select a site first.');
                return;
            }
            this.sync(this.getConfig(), { down: true, dry: true });
        };
        const syncUpSingle = () => this.syncSingle(this.getConfig(), false);
        const syncDownSingle = () => this.syncSingle(this.getConfig(), true);
        const killSync = () => {
            if (this.currentSync) {
                this.currentSync.kill();
                this.syncKilled = true;
            }
        };
        const showOutput = () => this.outputChannel.show();
        const showSiteMenu = () => this.showSiteMenu();

        const config = this.getConfig();
        if (config.onFileSave) {
            workspace.onDidSaveTextDocument(() => {
                if (this.currentSite) {
                    syncUp();
                }
            });
        }

        if (config.onFileSaveIndividual) {
            workspace.onDidSaveTextDocument((doc) => {
                const relativePath = workspace.asRelativePath(doc.uri);
                this.syncFile(config, relativePath, false);
            });
        }

        if (config.onFileLoadIndividual) {
            workspace.onDidOpenTextDocument((doc) => {
                const relativePath = workspace.asRelativePath(doc.uri);
                this.syncFile(config, relativePath, true);
            });
        }

        this.watch(config);

        this.disposables.push(
            commands.registerCommand('sync-rsync.syncUp', syncUp),
            commands.registerCommand('sync-rsync.syncDown', syncDown),
            commands.registerCommand('sync-rsync.compareUp', compareUp),
            commands.registerCommand('sync-rsync.compareDown', compareDown),
            commands.registerCommand('sync-rsync.syncUpSingle', syncUpSingle),
            commands.registerCommand('sync-rsync.syncDownSingle', syncDownSingle),
            commands.registerCommand('sync-rsync.killSync', killSync),
            commands.registerCommand('sync-rsync.showOutput', showOutput),
            commands.registerCommand('sync-rsync.syncUpContext', syncUp),
            commands.registerCommand('sync-rsync.syncDownContext', syncDown),
            commands.registerCommand('sync-rsync.showSiteMenu', showSiteMenu)
        );

        context.subscriptions.push(...this.disposables);
    }

    public deactivate(): void {
        this.disposables.forEach(d => d.dispose());
        this.outputChannel.dispose();
        this.statusBar.dispose();
    }
}

export function activate(context: ExtensionContext): void {
    const extension = new RsyncExtension();
    extension.activate(context);
}

export function deactivate(): void {
    // Cleanup is handled by the extension instance
}