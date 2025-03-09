import type { editor, languages } from 'monaco-editor';
import { isCorrectedModel, type changeDiagnosticOperation, type CorrecedModel, type ModelDiagnostic, type ParagraphKind } from '../../routes/diff.svelte';
import { renderMarkdown } from '$lib';

let MonacoPromise: Promise<typeof import('monaco-editor')> | undefined;

const updateCodeLensListener = [] as ({ onChange: () => void })[];

export function updateCodeLens() {
    updateCodeLensListener.forEach((listener) => {
        listener.onChange();
    });
}

export async function monaco_init() {

    if (!MonacoPromise) {

        MonacoPromise = import('monaco-editor');
        const Monaco = await MonacoPromise;




        Monaco.languages.registerCodeActionProvider('markdown', {
            provideCodeActions: function (model, range, context, token) {
                if (!isCorrectedModel(model)) {
                    return {
                        actions: [],
                        dispose: () => { }
                    }
                }

                const diagnostics = model.getDiagnostic(range);




                const actions = diagnostics.flatMap((diagnostic) => {
                    const commands = [
                        ...[{
                            id: 'applyDiagnosticChange',
                            title: 'in Wörterbuch aufnehmen',
                            arguments: [model, diagnostic, 'original with dictionary'] as const,
                        } satisfies languages.Command].filter(() => diagnostic.rule?.id == "GERMAN_SPELLER_RULE"),
                        ...[{
                            id: 'applyDiagnosticChange',
                            title: 'Original wiederherstellen',
                            arguments: [model, diagnostic, 'original'] as const,
                        } satisfies languages.Command].filter(() => diagnostic.replacedWith != undefined),
                        ...diagnostic.alternativeReplacement.map((alternative) => ({
                            id: 'applyDiagnosticChange',
                            title: alternative,
                            arguments: [model, diagnostic, { replace: alternative }] as const,
                        } satisfies languages.Command)),
                    ] satisfies languages.Command[];

                    return commands.map((command) => ({
                        title: command.title,
                        diagnostics: [{
                            startColumn: diagnostic.columnStart,
                            startLineNumber: diagnostic.lineStart,
                            endColumn: diagnostic.columnEnd,
                            endLineNumber: diagnostic.lineEnd,
                            severity: command.arguments[1].alternativeReplacement.length > 0 ? Monaco.MarkerSeverity.Warning : Monaco.MarkerSeverity.Info,
                            message: diagnostic.message,
                        }],
                        command,
                        // edit: {
                        //     edits: [{
                        //         resource: model.uri,
                        //         textEdit: {
                        //             range: {
                        //                 startColumn: diagnostic.columnStart,
                        //                 startLineNumber: diagnostic.lineStart,
                        //                 endColumn: diagnostic.columnEnd,
                        //                 endLineNumber: diagnostic.lineEnd,
                        //             },
                        //             text: 'Hallo'
                        //         },
                        //         versionId: model.getVersionId()
                        //     }],
                        // },

                        kind: 'quickfix',
                    }) satisfies languages.CodeAction);
                });

                return {
                    actions,
                    dispose: () => { }
                };


            },
            resolveCodeAction: function (codeAction, token) {
                return codeAction;
            }
        });

        Monaco.editor.registerCommand('applyDiagnosticChange', (accessor, model: CorrecedModel, diagnosticl: ModelDiagnostic, operation: changeDiagnosticOperation) => {
            model.changeDiagnostic(operation, diagnosticl);
        })

        const codeLenstProvider = {
            onDidChange: function (onChange) {
                const holder = { onChange: () => onChange(codeLenstProvider) };
                updateCodeLensListener.push(holder);
                return {
                    dispose: () => {
                        const index = updateCodeLensListener.indexOf(holder);
                        if (index != -1) {
                            updateCodeLensListener.splice(index, 1);
                        }
                    }
                }
            },
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
                        // const info = model.metadata.paragraphInfo[dataIndex];
                        const currentKind = model.getCurrentKind(dataIndex);

                        const currentJugement = model.metadata.paragraphInfo[dataIndex].judgment;

                        const totalCorrection = (model.configuredModels.modelNames.length * (model.configuredModels.styles.length + 1)) + 1;
                        const currentCorrection = Object.entries(currentJugement)
                            .filter(([modelName]) => model.configuredModels.modelNames.includes(modelName))
                            .map(([, judgment]) => {
                                return Object.keys(judgment.text.alternative).filter((alternative) => model.configuredModels.styles.includes(alternative)).length
                                    + (judgment.text.correction != undefined ? 1 : 0);
                            })
                            .reduce((acc, val) => acc + val, 0)
                            + (model.metadata.paragraphInfo[dataIndex].corrected?.text != undefined ? 1 : 0);

                        return [
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
                            ...[
                                {
                                    range: value.range,
                                    command: {
                                        id: `review`,
                                        title: `Review (${typeof currentKind == 'string'
                                            ? currentKind
                                            : currentKind[1] == 'correction'
                                                ? `Korrektur ${currentKind[0]}`
                                                : currentKind[1] == 'alternative'
                                                    ? `Formulirung ${currentKind[0]}->${currentKind[2]}`
                                                    : 'unknown'
                                            }) ${(currentCorrection == totalCorrection ? '' : `[${currentCorrection}/${totalCorrection}]`)}`,
                                        tooltip: 'Displays a message',
                                        arguments: [value, model]
                                    }
                                }
                            ].filter(() => Object.keys(model.metadata.paragraphInfo[dataIndex].judgment).length != 0),


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
                            ...[{
                                range: value.range,
                                command: {
                                    id: `switchKind`,
                                    title: `Korrigiert`,
                                    tooltip: 'Displays a message',
                                    arguments: ['corrected', value, model]
                                }
                            }].filter(() => model.hasKind(dataIndex, 'corrected') && currentKind != 'corrected'),


                            // ...Object.keys(model.metadata.paragraphInfo[dataIndex].judgment)
                            //     .map(usedModel => ({
                            //         range: value.range,
                            //         command: {
                            //             id: `review`,
                            //             title: `Judgement ${info.judgment[usedModel].score} (${usedModel})`,
                            //             tooltip: 'Displays a message',
                            //             arguments: [value, usedModel, model]
                            //         }
                            //     })),


                            // ...Object.keys(model.metadata.paragraphInfo[dataIndex].judgment)
                            //     .flatMap(usedModel => [...[{
                            //         range: value.range,
                            //         command: {
                            //             id: `switchKind`,
                            //             title: `Korrektur (${usedModel})`,
                            //             tooltip: 'Displays a message',
                            //             arguments: [[usedModel, 'correction'], value, model]
                            //         }
                            //     }].filter(() => currentKind != [usedModel, 'correction'] as const),
                            //     ...Object.keys(model.metadata.paragraphInfo[dataIndex].judgment[usedModel].text.alternative)
                            //         .map(desired => ({
                            //             range: value.range,
                            //             command: {
                            //                 id: `switchKind`,
                            //                 title: `Formulirung (${usedModel}->${desired})`,
                            //                 tooltip: 'Displays a message',
                            //                 arguments: [[usedModel, 'alternative', desired], value, model] as const
                            //             }
                            //         })).filter((v) => currentKind != [usedModel, 'alternative', v.command.arguments[0][2]] as const),
                            // ])
                        ];
                    })

                    ,
                    dispose: () => { }
                };
            },
            resolveCodeLens: function (model, codeLens) {
                console.log('resolving codeLens')
                return codeLens;
            }
        } satisfies languages.CodeLensProvider;

        Monaco.languages.registerCodeLensProvider('markdown', codeLenstProvider);


        Monaco.editor.registerCommand('switchKind', (accessor, kind: ParagraphKind, decoration: editor.IModelDecoration, model: CorrecedModel) => {
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
            if (paragraphInfo.judgment == undefined) {
                return;
            }

            const editor = Monaco.editor.getEditors().filter(x => x.getModel() === model)[0]
                ?? Monaco.editor.getDiffEditors().filter(x => x.getModel()?.modified === model)[0];



            const currentKind = model.getCurrentKind(index);







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


            const list = document.createElement('ul');
            list.classList.add('models');
            textHolder.appendChild(list);
            const kindChangedListener = [] as ((newKind: ParagraphKind) => void)[];
            function updateKind(newKind: ParagraphKind) {
                kindChangedListener.forEach(x => x(newKind));
            }
            Object.keys(paragraphInfo.judgment).forEach((modelName) => {
                const item = document.createElement('li');
                list.appendChild(item);
                const button = document.createElement('button');
                item.appendChild(button);

                button.innerText = `Korrektur ${modelName} (${paragraphInfo.judgment[modelName].score})`;
                button.classList.add('text');
                if (paragraphInfo.judgment[modelName].text.correction == paragraphInfo.original) {
                    button.disabled = true;
                }




                if (currentKind == [modelName, 'correction'] as const) {
                    button.classList.add('selected');
                }

                kindChangedListener.push((changedKind) => {
                    if (typeof changedKind == 'string') {
                        return;
                    }
                    const [newModelName, newKind] = changedKind;
                    if (newModelName === modelName && newKind === 'correction') {
                        button.classList.add('selected');
                    } else {
                        button.classList.remove('selected');
                    }
                });

                button.onclick = () => {
                    model.setKind(index, [modelName, 'correction']);
                    updateKind(model.getCurrentKind(index));
                }
                const subList = document.createElement('ul');
                item.appendChild(subList);

                Object.keys(paragraphInfo.judgment[modelName].text.alternative).forEach((alternative) => {
                    const subItem = document.createElement('li');
                    subList.appendChild(subItem);
                    const subButton = document.createElement('button');
                    subItem.appendChild(subButton);
                    subButton.innerText = `Formulirung ${alternative}`;
                    subButton.classList.add('text');
                    const [newModelName, newKind, newAlternative] = currentKind;
                    if (newModelName === modelName && newKind === 'alternative' && newAlternative === alternative) {
                        subButton.classList.add('selected');
                    }
                    if (paragraphInfo.judgment[modelName].text.alternative[alternative] == paragraphInfo.original) {
                        subButton.disabled = true;
                    }
                    kindChangedListener.push((changedKind) => {
                        if (typeof changedKind == 'string') {
                            return;
                        }
                        const [newModelName, newKind, newAlternative] = changedKind;
                        if (newModelName === modelName && newKind === 'alternative' && newAlternative === alternative) {
                            subButton.classList.add('selected');
                        } else {
                            subButton.classList.remove('selected');
                        }
                    });
                    subButton.onclick = () => {
                        model.setKind(index, [modelName, 'alternative', alternative]);
                        updateKind(model.getCurrentKind(index));
                    }
                });
            });












            const goodPoints = document.createElement('div');
            goodPoints.classList.add('points');
            goodPoints.classList.add('good');
            goodPoints.innerText = 'Good points Loading…';
            textHolder.appendChild(goodPoints);
            kindChangedListener.push((changedKind) => {
                if (typeof changedKind == 'string') {
                    return;
                }
                const [newModelName] = changedKind;
                Promise.all(paragraphInfo.judgment[newModelName].goodPoints.map(renderMarkdown)).then((htmls) => {
                    goodPoints.innerHTML = htmls.join('');
                });
            });
            const badPoints = document.createElement('div');
            badPoints.classList.add('points');
            badPoints.classList.add('bad');
            badPoints.innerText = 'Bad points Loading…';
            textHolder.appendChild(badPoints);
            kindChangedListener.push((changedKind) => {
                if (typeof changedKind == 'string') {
                    return;
                }
                const [newModelName] = changedKind;
                Promise.all(paragraphInfo.judgment[newModelName].badPoints.map(renderMarkdown)).then((htmls) => {
                    badPoints.innerHTML = htmls.join('');
                });
            });
            overlayDom.appendChild(textHolder);

            const bottomGrip = document.createElement('div');
            bottomGrip.classList.add('grip');
            overlayDom.appendChild(bottomGrip);

            const moreDetails = document.createElement('details');
            moreDetails.classList.add('protocol-details');
            const summary = document.createElement('summary');
            summary.innerText = 'More Details';
            moreDetails.appendChild(summary);
            const details = document.createElement('div');
            moreDetails.appendChild(details);
            textHolder.appendChild(moreDetails);

            kindChangedListener.push((changedKind) => {
                if (typeof changedKind == 'string') {
                    return;
                }
                const [newModelName] = changedKind;
                const judgment = paragraphInfo.judgment[newModelName];
                details.innerHTML = '';
                if (judgment.protocol != undefined && judgment.protocol.length > 0) {
                    const protocol = document.createElement('ul');
                    details.appendChild(protocol);
                    judgment.protocol.forEach((point) => {
                        const item = document.createElement('li');
                        const style = document.createElement('div');
                        const change = document.createElement('div');
                        const newValue = document.createElement('pre');
                        const oldValue = document.createElement('pre');
                        style.innerText = point.style;
                        change.innerText = point.description;
                        newValue.innerText = JSON.stringify(point.newValue, null, 2);
                        oldValue.innerText = JSON.stringify(point.oldValue, null, 2);
                        item.appendChild(style);
                        item.appendChild(change);
                        item.appendChild(newValue);
                        item.appendChild(oldValue);
                        protocol.appendChild(item);
                    });
                }
            });






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
                    } else if (scrollDown && atBottom) {
                        // do not stop propagation
                    } else {
                        e.stopPropagation();
                    }
                } else {
                    // console.log('no scroll', { scrollHeight,realScrollHeight:textHolder.scrollHeight, clientHeight: textHolder.clientHeight });
                }
            }


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
                editor.removeOverlayWidget(overlayWidget);
                overlayDom.remove();
            }

        });

    }


    return await MonacoPromise;


}