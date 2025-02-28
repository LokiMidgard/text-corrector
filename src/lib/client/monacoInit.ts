import type { editor } from 'monaco-editor';
import { isCorrectedModel, type CorrecedModel, type ParagraphKind } from '../../routes/diff.svelte';
import { renderMarkdown } from '$lib';

let MonacoPromise: Promise<typeof import('monaco-editor')> | undefined;


export async function monaco_init() {

    if (!MonacoPromise) {

        MonacoPromise = import('monaco-editor');
        const Monaco = await MonacoPromise;

        Monaco.languages.registerCodeLensProvider('markdown', {
            provideCodeLenses: function (model) {
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

                        return [
                            ...[{
                                range: value.range,
                                command: {
                                    id: `switchKind`,
                                    title: `Original`,
                                    tooltip: 'Displays a message',
                                    arguments: ['original', value, model]
                                }
                            }].filter(() => model.hasKind(dataIndex, 'original') && currentKind != 'original'),
                            ...[{
                                range: value.range,
                                command: {
                                    id: `switchKind`,
                                    title: `Editiert`,
                                    tooltip: 'Displays a message',
                                    arguments: ['edited', value, model]
                                }
                            }].filter(() => model.hasKind(dataIndex, 'edited') && currentKind != 'edited'),


                            ...Object.keys(model.metadata.paragraphInfo[dataIndex].judgment)
                                .map(usedModel => ({
                                    range: value.range,
                                    command: {
                                        id: `review`,
                                        title: `Judgement ${info.judgment[usedModel].score} (${usedModel})`,
                                        tooltip: 'Displays a message',
                                        arguments: [value, usedModel, model]
                                    }
                                })),
                            ...[
                                {
                                    range: value.range,
                                    command: {
                                        id: `review`,
                                        title: 'Review not yet done',
                                        tooltip: 'Displays a message',
                                        arguments: [value, model]
                                    }
                                }
                            ].filter(() => Object.keys(model.metadata.paragraphInfo[dataIndex].judgment).length == 0),


                            ...Object.keys(model.metadata.paragraphInfo[dataIndex].judgment)
                                .flatMap(usedModel => [...[{
                                    range: value.range,
                                    command: {
                                        id: `switchKind`,
                                        title: `Korrektur (${usedModel})`,
                                        tooltip: 'Displays a message',
                                        arguments: [[usedModel, 'correction'], value, model]
                                    }
                                }].filter(() => currentKind != [usedModel, 'correction'] as const), ...Object.keys(model.metadata.paragraphInfo[dataIndex].judgment)
                                    .map(desired => ({
                                        range: value.range,
                                        command: {
                                            id: `switchKind`,
                                            title: `Korrektur (${usedModel})`,
                                            tooltip: 'Displays a message',
                                            arguments: [[usedModel, 'alternative', desired], value, model] as const
                                        }
                                    })).filter((v) => currentKind != [usedModel, 'alternative', v.command.arguments[0][2]] as const),

                                ])];
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
        Monaco.editor.registerCommand('review', (accessor, decoration: editor.IModelDecoration, usedModel: string, model: CorrecedModel) => {
            const index = model.getIndexOfDecorationKey(decoration.id);
            if (index == undefined) {
                throw new Error('Faild to get data');
            }
            const paragraphInfo = model.metadata.paragraphInfo[index];
            if (paragraphInfo.judgment == undefined) {
                return;
            }

            const editor = Monaco.editor.getEditors().filter(x => x.getModel() === model)[0]
                ?? Monaco.editor.getDiffEditors().filter(x => x.getModel()?.modified === model)[0];






            // Create a zone over the margin. Uses the trick explained
            // at https://github.com/Microsoft/monaco-editor/issues/373

            // overlay that will be placed over the zone.
            const overlayDom = document.createElement('div');
            overlayDom.id = 'overlayId';
            overlayDom.classList.add('overlay');

            const header = document.createElement('header');
            header.innerText = `Judgement ${paragraphInfo.judgment?.score} by ${paragraphInfo.judgment?.model ?? 'unknown'}`;
            overlayDom.appendChild(header);

            const button = document.createElement('button');
            // button.innerHTML = 'Remove';
            header.appendChild(button);

            const textHolder = document.createElement('div');
            textHolder.classList.add('text')

            const goodPoints = document.createElement('div');
            goodPoints.classList.add('points');
            goodPoints.classList.add('good');
            goodPoints.innerText = 'Good points Loading…';
            textHolder.appendChild(goodPoints);
            Promise.all(paragraphInfo.judgment[usedModel].goodPoints.map(renderMarkdown)).then((htmls) => {
                goodPoints.innerHTML = htmls.join('');
            });
            const badPoints = document.createElement('div');
            badPoints.classList.add('points');
            badPoints.classList.add('bad');
            badPoints.innerText = 'Bad points Loading…';
            textHolder.appendChild(badPoints);
            Promise.all(paragraphInfo.judgment[usedModel].badPoints.map(renderMarkdown)).then((htmls) => {
                badPoints.innerHTML = htmls.join('');
            });
            overlayDom.appendChild(textHolder);

            const bottomGrip = document.createElement('div');
            bottomGrip.classList.add('grip');
            overlayDom.appendChild(bottomGrip);




            // textHolder.style.background = 'green';
            textHolder.onwheel = (e) => {
                // only stop propagation if the overlay is scrollable
                // and is not at the end of the scroll
                const scrollHeight = textHolder.scrollHeight;
                const clientHeight = textHolder.getBoundingClientRect().height;
                if (scrollHeight > textHolder.clientHeight) {
                    const scrollUp = e.deltaY < 0;
                    const scrollDown = e.deltaY > 0;
                    const atTop = textHolder.scrollTop == 0;
                    const atBottom = Math.round(textHolder.scrollTop + clientHeight) >= scrollHeight;
                    if (scrollUp && atTop) {
                        // do not stop propagation
                        // console.log('at top');
                    } else if (scrollDown && atBottom) {
                        // do not stop propagation
                        // console.log('at bottom');
                    } else {
                        // console.log('stop');
                        e.stopPropagation();
                    }
                } else {
                    // console.log('no scroll', { scrollHeight,realScrollHeight:textHolder.scrollHeight, clientHeight: textHolder.clientHeight });
                }
            }

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

            const range = model.getDecorationRange(decoration.id);

            // Can be used to fill the margin
            const marginDomNode = document.createElement('div');
            marginDomNode.id = 'zoneMarginId';
            let zoneId: string | undefined = undefined;
            let top = 0;
            let height = 0;
            const getZone = (lines: number) => ({
                afterLineNumber: range!.startLineNumber - 1,
                heightInLines: Math.max(3, lines),
                domNode: zoneNode,
                marginDomNode: marginDomNode,
                onDomNodeTop: (top_value) => {
                    top = top_value;
                    overlayDom.style.top = top + 'px';
                },
                onComputedHeight: (height_value) => {
                    height = height_value;
                    overlayDom.style.height = height + 'px';
                }
            } satisfies editor.IViewZone);
            let currentLines = 10;
            editor.changeViewZones(function (changeAccessor) {
                zoneId = changeAccessor.addZone(getZone(currentLines));
            });

            // resize zone if the user pulls on the lower margin
            let isResizing = false;
            bottomGrip.onmousedown = () => {
                // if (e.target === bottomGrip) {
                isResizing = true;
                bottomGrip.classList.add('resize');
                document.body.style.cursor = 'ns-resize';
                document.body.style.userSelect = 'none';
                // }
            }

            document.onmousemove = (e) => {
                if (isResizing) {
                    e.preventDefault();
                    e.stopPropagation();

                    const bototmOfOverlay = overlayDom.getBoundingClientRect().bottom;
                    const distanceToEdge = e.clientY - bototmOfOverlay;
                    const minDiff = 40;
                    if (distanceToEdge > minDiff) {
                        currentLines++;
                        editor.changeViewZones(function (changeAccessor) {
                            if (zoneId == undefined) {
                                return;
                            }
                            changeAccessor.removeZone(zoneId);
                            zoneId = changeAccessor.addZone(getZone(currentLines))
                        });
                    } else if (distanceToEdge < -minDiff) {
                        currentLines--;
                        editor.changeViewZones(function (changeAccessor) {
                            if (zoneId == undefined) {
                                return;
                            }
                            changeAccessor.removeZone(zoneId);
                            zoneId = changeAccessor.addZone(getZone(currentLines))
                        });
                    }
                }
            }
            document.onmouseup = () => {
                isResizing = false;
                bottomGrip.classList.remove('resize');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';

            }


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