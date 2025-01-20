export class TextEditor {
    private editorElement: HTMLDivElement;

    constructor(container: HTMLDivElement) {
        this.editorElement = container;
        // this.editorElement.contentEditable = 'true';
        this.editorElement.tabIndex = 0;
        // make div focusable
        this.editorElement.style.overflow = 'auto';





        this.editorElement.style.minHeight = '200px';
        this.editorElement.style.whiteSpace = 'pre-wrap';
        this.editorElement.style.outline = 'none';

        this.editorElement.addEventListener('keydown', (e) => {
            console.log('keydown event', e);
            if (e.key === 'Tab') {
                e.preventDefault();
               
            }
            this.editorElement.addEventListener('input', (e) => {
                console.log('input event', e);
                this.highlightMarkdown()
            });
            // container.appendChild(this.editorElement);
        }
        );
    }

    private highlightMarkdown() {
        const selection = window.getSelection();
        let cursorPosition = 0;
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(this.editorElement);
            preCaretRange.setEnd(range.endContainer, range.endOffset);
            cursorPosition = preCaretRange.toString().length;
        }

        const text = this.editorElement.innerText;
        const html = text.replace(/\*\*(.*?)\*\*/g, '<b>**$1**</b>');

        this.editorElement.innerHTML = html;

        const newRange = document.createRange();
        let charIndex = 0;
        const nodeStack = [this.editorElement];
        let found = false;

        while (!found && nodeStack.length > 0) {
            const node = nodeStack.pop()!;
            if (node.nodeType === Node.TEXT_NODE) {
                const nextCharIndex = charIndex + node.textContent!.length;
                if (cursorPosition >= charIndex && cursorPosition <= nextCharIndex) {
                    newRange.setStart(node, cursorPosition - charIndex);
                    newRange.collapse(true);
                    found = true;
                }
                charIndex = nextCharIndex;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                for (let i = node.childNodes.length - 1; i >= 0; i--) {
                    nodeStack.push(node.childNodes[i]);
                }
            }
        }

        if (found) {
            selection?.removeAllRanges();
            selection?.addRange(newRange);
        }
    }

    getRawText(): string {
        return this.editorElement.innerText;
    }

    getSelectedRawText(): string {
        const selection = window.getSelection();
        return selection ? selection.toString() : '';
    }

    setSelection(start: number, end: number) {
        const range = document.createRange();
        range.setStart(this.editorElement.childNodes[0] || this.editorElement, start);
        range.setEnd(this.editorElement.childNodes[0] || this.editorElement, end);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }
}