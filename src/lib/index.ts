// place files you want to import through the `$lib` alias in this folder.

import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

export async function renderMarkdown(md: string): Promise<string> {
    const sanitizedHtml = await unified()
        .use(remarkParse)
        .use(remarkRehype)
        .use(rehypeSanitize)
        .use(rehypeStringify)
        .process(md);

    return String(sanitizedHtml);
}