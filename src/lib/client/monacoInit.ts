import type { MetadataType } from '../../routes/diff.svelte';

let MonacoPromise: Promise<typeof import('monaco-editor')> | undefined;


export async function monaco_init() {

    if (!MonacoPromise) {

        MonacoPromise = import('monaco-editor');
        const Monaco = await MonacoPromise;

        Monaco.languages.registerCodeLensProvider('markdown', {
            provideCodeLenses: function (model, token) {
                console.log('provideCodeLenses', model, token);

                const metadata = (model as unknown as { metadata: MetadataType | undefined }).metadata;

                return {
                    lenses: Object.entries(metadata?.paragraphInfo ?? {}).map(([, value]) => {
                        return {
                            range: new Monaco.Range(value.lines.start, 1, value.lines.start, 1),
                            command: {
                                id: `review`,
                                title: `Judgement ${value.judgment} (${value.lines.start} - ${value.lines.end})`,
                                tooltip: 'Displays a message',
                                arguments: [value, model, metadata]
                            }
                        }
                    })

                    ,
                    dispose: () => { }
                };
            },
            resolveCodeLens: function (model, codeLens, token) {
                return codeLens;
            }
        });

        Monaco.editor.registerCommand('review', (accessor, paragraphInfo: MetadataType['paragraphInfo'][number], model, metadata: MetadataType) => {
            console.log('review', paragraphInfo);
            const editor = Monaco.editor.getEditors().filter(x => x.getModel() === model)[0]
                ?? Monaco.editor.getDiffEditors().filter(x => x.getModel()?.modified === model)[0];


                

            // Create a zone over the margin. Uses the trick explained
            // at https://github.com/Microsoft/monaco-editor/issues/373

            // overlay that will be placed over the zone.
            const overlayDom = document.createElement('div');
            overlayDom.id = 'overlayId';
            overlayDom.classList.add('overlay');
            overlayDom.style.width = '100%';
            overlayDom.style.background = '#ffb275';
            const button = document.createElement('button');
            button.innerHTML = 'Remove';
            overlayDom.appendChild(button);
            overlayDom.innerText=paragraphInfo.alternative;

            console.log("height", overlayDom.clientHeight);

            // https://microsoft.github.io/monaco-editor/api/interfaces/monaco.editor.ioverlaywidget.html
            const overlayWidget = {
                getId: () => 'overlay.zone.widget',
                getDomNode: () => overlayDom,
                getPosition: () => null
            };
            editor.addOverlayWidget(overlayWidget);

            // Used only to compute the position.
            const zoneNode = document.createElement('div');
            zoneNode.style.background = '#8effc9';
            zoneNode.id = 'zoneId';

            // Can be used to fill the margin
            const marginDomNode = document.createElement('div');
            marginDomNode.style.background = '#ff696e';
            marginDomNode.id = 'zoneMarginId';
            let zoneId: string | undefined = undefined;
            editor.changeViewZones(function (changeAccessor) {
                zoneId = changeAccessor.addZone({
                    afterLineNumber: paragraphInfo.lines.start,
                    heightInLines: Math.max(paragraphInfo.alternative.split('\n').length, 10),
                    domNode: zoneNode,
                    marginDomNode: marginDomNode,
                    onDomNodeTop: (top) => {
                        overlayDom.style.top = top + 'px';
                    },
                    onComputedHeight: (height) => {
                        overlayDom.style.height = height + 'px';
                    }
                });
            });

            // remove Zone if remove button is pressed
            button.onclick = () => {
                editor.changeViewZones(function (changeAccessor) {
                    zoneNode.remove();
                    if (zoneId)
                        changeAccessor.removeZone(zoneId);
                });
                overlayDom.remove();
            }

        });

    }

    return await MonacoPromise;


}