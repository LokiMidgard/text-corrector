import type { NewCorrectionMetadata } from "$lib/server/git";
import type { MetadataType } from "../../routes/diff.svelte";


import { trpc } from '$lib/trpc/client';
import { DateTime } from "luxon";


export class Model {
	localUpdate(path: string, metadata: MetadataType) {
        this.models[path] = metadata;
        window.localStorage.setItem(getKey(metadata), JSON.stringify(metadata));
        // fire the event for content changes
        this.lisenersContent.forEach((listener) => {
            listener(metadata);
        });
    }

    private static instance: Promise<Model> | null = null;

    private models: Record<string, MetadataType> = {};

    private currentRunningPath: string | undefined = undefined;

    private connectedToBackend = false;
    private readonly client: ReturnType<typeof trpc>;

    public get connected() {
        return this.connectedToBackend;
    }

    private _configuredModels: {
        modelNames: string[];
        styles: string[];
    } = {
            modelNames: [],
            styles: [],
        };

    public get commitDetails() {
        return this.client.getCommitData.query();
    }


    public get currentPath() {
        return this.currentRunningPath;
    }

    public get configuredModels() {
        return this._configuredModels;
    }

    public addWordToDictionary(word: string) {
        return this.client.addWordToDictionary.query(word);
    }

    public saveCorrection(type: 'commit', path: string, metadata: string, commitDetails: { author: { name: string, email: string }, message: string }): Promise<void>;
    public saveCorrection(type: 'draft', path: string, metadata: MetadataType, commitDetails: { author: { name: string, email: string }, message: string }): Promise<void>;
    public async saveCorrection(type: 'commit' | 'draft', path: string, metadata: MetadataType | string, commitDetails: { author: { name: string, email: string }, message: string }) {
        if (type == 'commit') {
            if (typeof metadata != 'string') {
                throw new Error('metadata must be a string');
            }
            await this.client.finishText.query({ path, text: metadata, commitDetails });
        } else {
            if (typeof metadata == 'string') {
                throw new Error('metadata must be a MetadataType');
            }
            await this.client.updateText.query({ path, metadata: metadata, commitDetails });
        }
    }

    constructor() {
        this.client = trpc();
        const keys = Object.keys(window.localStorage);
        for (const key of keys) {
            if (key.startsWith('meta:path')) {
                const meta = JSON.parse(window.localStorage.getItem(key) ?? '') as MetadataType;
                this.models[meta.path] = meta;
            }
        }
    }
    private async init() {
        this.client.onMessage.subscribe(undefined, {
            onData: (data) => {
                if (data) {
                    if (this.currentRunningPath != data.path) {
                        this.currentRunningPath = data.path;
                        this.lisenersCurrentPath.forEach((listener) => {
                            listener(data.path);
                        });
                    }
                    this.applyUpdate(data.path, data as NewCorrectionMetadata);
                }
            }
        });
        this.client.onModelChange.subscribe(undefined, {
            onStarted: () => {
                this.connectedToBackend = true;
                console.log('Started listening to model changes');
                this.lisenersConnected.forEach((listener) => {
                    listener(true);
                });
            },
            onError: (error) => {
                console.error('Error while listening to model changes', error);
            },
            onStopped: () => {
                this.connectedToBackend = false;
                console.log('Stopped listening to model changes');
                this.lisenersConnected.forEach((listener) => {
                    listener(false);
                });
            },
            onComplete: () => {
                console.log('Completed listening to model changes');
                this.connectedToBackend = false;
                this.lisenersConnected.forEach((listener) => {
                    listener(false);
                });
            },
            onData: (data) => {
                console.log('Model changed', data);
                this._configuredModels = data;
                this.lisenersModels.forEach((listener) => {
                    listener(this._configuredModels);
                });
            },
        });


        const remoteCorrections = await this.client.getCorrections.query();
        for (const correction of remoteCorrections) {
            const path = correction.path;
            this.applyUpdate(path, correction as NewCorrectionMetadata);
        }
    }

    private async applyUpdate(path: string, newMetadata: NewCorrectionMetadata) {
        const meta = this.models[path];
        if (meta) {
            meta.timestamp = DateTime.now().toObject();
            // we need to merge the  data
            for (let i = 0; i < newMetadata.paragraphInfo.length; i++) {
                const newParagraph = newMetadata.paragraphInfo[i];
                const oldParagraphInfo = meta.paragraphInfo[i];


                if (oldParagraphInfo.original != newParagraph.original) {
                    // we have a new original text, so everything we done so far is obsolete
                    oldParagraphInfo.edited = newParagraph.edited;
                    oldParagraphInfo.editedOriginal = newParagraph.edited;
                    oldParagraphInfo.selectedText = newParagraph.selectedText;
                    oldParagraphInfo.original = newParagraph.original;
                    oldParagraphInfo.corrected = newParagraph.corrected;
                    oldParagraphInfo.judgment = newParagraph.judgment;
                } else {
                    oldParagraphInfo.corrected = newParagraph.corrected;
                    oldParagraphInfo.judgment = newParagraph.judgment;

                    if (oldParagraphInfo.selectedText == undefined) {
                        oldParagraphInfo.selectedText = newParagraph.selectedText;
                    }

                    if (oldParagraphInfo.editedOriginal != newParagraph.edited) {
                        // edited changed serverside, if we have already edited it, we need to merge the data
                        if (oldParagraphInfo.edited == undefined) {
                            // we have not edited it yet, so we can just take the new one
                            oldParagraphInfo.edited = newParagraph.edited;
                            oldParagraphInfo.editedOriginal = newParagraph.edited;
                        } else if (oldParagraphInfo.edited == newParagraph.edited || oldParagraphInfo.editedOriginal == newParagraph.edited) {
                            // our version is either the same as the server version before the edit or the same as the server version now, so we can just take the new one
                            oldParagraphInfo.edited = newParagraph.edited;
                            oldParagraphInfo.editedOriginal = newParagraph.edited;
                        } else {
                            // we have edited it, but the server has also changed it
                            oldParagraphInfo.edited = `
=== LOCAL EDITED ===
${oldParagraphInfo.edited}
=== SERVER EDITED ===
${newParagraph.edited}
=== END ===`;
                            oldParagraphInfo.editedOriginal = newParagraph.edited;
                        }
                    }
                }
            }
        } else {
            this.models[path] = {
                ...newMetadata,
                path,
                timestamp: DateTime.now().toObject(),
            };
            // frire the event for pathes changes
            this.lisenersPathes.forEach((listener) => {
                listener(this.pathes);
            });
        }

        const updatedMeta = this.models[path];
        window.localStorage.setItem(getKey(updatedMeta), JSON.stringify(updatedMeta));
        // fire the event for content changes
        this.lisenersContent.forEach((listener) => {
            listener(updatedMeta);
        });

    }



    public static async getInstance() {
        if (!Model.instance) {
            Model.instance = new Promise((resolve) => {
                const instance = new Model();
                instance.init().then(() => {
                    resolve(instance);
                });
            });
        }
        return Model.instance;
    }


    public get pathes(): string[] {
        return Object.keys(this.models);
    }

    public getCorrection(path: string) {
        const correction = this.models[path];
        if (correction) {
            return correction;
        }
        throw new Error(`No correction found for path ${path}`);
    }

    // add event for remote changes
    private lisenersCurrentPath: ((path: string) => void)[] = [];
    private lisenersModels: ((meta: typeof this._configuredModels) => void)[] = [];
    private lisenersContent: ((meta: MetadataType) => void)[] = [];
    private lisenersPathes: ((pathes: string[]) => void)[] = [];
    private lisenersConnected: ((connected: boolean) => void)[] = [];


    public onChange(change: 'connected', callback: (isConnected: boolean) => void): void;
    public onChange(change: 'currentPath', callback: (path: string) => void): void;
    public onChange(change: 'models', callback: (meta: typeof this._configuredModels) => void): void;
    public onChange(change: 'content', callback: (meta: MetadataType) => void): void;
    public onChange(change: 'pathes', callback: (meta: string[]) => void): void;
    public onChange(change: 'pathes' | 'content' | 'connected' | 'models' | 'currentPath', callback: ((meta: MetadataType) => void) | ((pathes: string[]) => void) | ((models: typeof this._configuredModels) => void) | ((models: string) => void) | ((isConnected: boolean) => void)): void {
        if (change == 'content') {
            this.lisenersContent.push(callback as (meta: MetadataType) => void);
        } else if (change == 'currentPath') {
            this.lisenersCurrentPath.push(callback as (path: string) => void);
        } else if (change == 'connected') {
            this.lisenersConnected.push(callback as (isConnected: boolean) => void);
        } else if (change == 'models') {
            this.lisenersModels.push(callback as (meta: typeof this._configuredModels) => void);
        } else {
            this.lisenersPathes.push(callback as (pathes: string[]) => void);
        }
    }
}


function getKey(meta: MetadataType) {
    return `meta:path${meta.path}`;
}

