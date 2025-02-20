import type { editor } from 'monaco-editor';
import { isCorrectedModel, kinds, type CorrecedModel, type MetadataType, type ParagraphKind } from '../../routes/diff.svelte';
import { renderMarkdown } from '$lib';

let MonacoPromise: Promise<typeof import('monaco-editor')> | undefined;


export async function monaco_init() {

    if (!MonacoPromise) {

        MonacoPromise = import('monaco-editor');
        const Monaco = await MonacoPromise;

        Monaco.languages.registerCodeLensProvider('markdown', {
            provideCodeLenses: function (model, token) {
                if (!isCorrectedModel(model)) {
                    return {
                        lenses: [],
                        dispose: () => { }
                    };
                }

                const decorations = model.getAllDecorations(undefined, true)
                    .filter(x => model.getIndexOfDecorationKey(x.id) != undefined);




                return {
                    lenses: decorations.flatMap((value) => {
                        const dataIndex = model.getIndexOfDecorationKey(value.id);
                        if (dataIndex == undefined) {
                            throw new Error('Faild to get data');
                        }
                        const info = model.metadata.paragraphInfo[dataIndex];
                        const currentKind = model.getCurrentKind(dataIndex);
                        if (currentKind == 'alternative') {
                            console.log('alternative', value.range);
                        }
                        return [{
                            range: value.range,
                            command: {
                                id: `review`,
                                title: `Judgement ${info.judgment} (${currentKind})`,
                                tooltip: 'Displays a message',
                                arguments: [value, model]
                            }
                        }, ...kinds.filter(x => model.hasKind(dataIndex, x) && x != model.getCurrentKind(dataIndex)).map(kind => ({
                            range: value.range,
                            command: {
                                id: `switchKind`,
                                title: `${kind}`,
                                tooltip: 'Displays a message',
                                arguments: [kind, value, model]
                            }
                        })),]
                    })

                    ,
                    dispose: () => { }
                };
            },
            resolveCodeLens: function (model, codeLens) {
                return codeLens;
            }
        });

        Monaco.editor.registerCommand('switchKind', (accessor, kind: ParagraphKind, decoration: editor.IModelDecoration, model: CorrecedModel) => {
            console.log('switchKind', kind, decoration);
            const dataIndex = model.getIndexOfDecorationKey(decoration.id);
            if (dataIndex == undefined) {
                throw new Error('Faild to get data');
            }
            model.setKind(dataIndex, kind);

        });
        Monaco.editor.registerCommand('review', (accessor, decoration: editor.IModelDecoration, model: CorrecedModel) => {
            const index = model.getIndexOfDecorationKey(decoration.id);
            if (index == undefined) {
                throw new Error('Faild to get data');
            }
            const paragraphInfo = model.metadata.paragraphInfo[index];

            const editor = Monaco.editor.getEditors().filter(x => x.getModel() === model)[0]
                ?? Monaco.editor.getDiffEditors().filter(x => x.getModel()?.modified === model)[0];






            // Create a zone over the margin. Uses the trick explained
            // at https://github.com/Microsoft/monaco-editor/issues/373

            // overlay that will be placed over the zone.
            const overlayDom = document.createElement('div');
            overlayDom.id = 'overlayId';
            overlayDom.classList.add('overlay');
            overlayDom.style.width = '100%';
            const button = document.createElement('button');
            button.innerHTML = 'Remove';
            overlayDom.appendChild(button);

            const textHolder = document.createElement('div');

            const goodPoints = document.createElement('div');
            goodPoints.classList.add('points');
            goodPoints.classList.add('good');
            goodPoints.innerText = 'Good points Loading…';
            textHolder.appendChild(goodPoints);
            renderMarkdown(paragraphInfo.goodPoints).then((html) => {
                goodPoints.innerHTML = html;
            });
            const badPoints = document.createElement('div');
            badPoints.classList.add('points');
            badPoints.classList.add('bad');
            badPoints.innerText = 'Bad points Loading…';
            textHolder.appendChild(badPoints);
            renderMarkdown(paragraphInfo.badPoints).then((html) => {
                badPoints.innerHTML = html;
            });


            overlayDom.appendChild(textHolder);

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
            zoneNode.id = 'zoneId';

            // Can be used to fill the margin
            const marginDomNode = document.createElement('div');
            marginDomNode.id = 'zoneMarginId';
            let zoneId: string | undefined = undefined;
            editor.changeViewZones(function (changeAccessor) {
                zoneId = changeAccessor.addZone({
                    afterLineNumber: paragraphInfo.lines.start - 1,
                    heightInLines: 10,
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