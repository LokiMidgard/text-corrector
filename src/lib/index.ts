// place files you want to import through the `$lib` alias in this folder.

import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import remarkStringify from 'remark-stringify';
import remarkBreakLine from 'remark-break-line';
import remarkWiki from 'remark-wiki-link';
import type { BlockContent, DefinitionContent, Paragraph, Root, RootContent } from 'mdast';
import { Duration, type DurationLike, type DurationLikeObject } from "luxon";


type timeUnit = 'years' | 'months' | 'days' | 'hours' | 'minutes' | 'seconds' | 'milliseconds';

export function reduceDuration(duration: DurationLikeObject, options?: { skip?: readonly (timeUnit)[], keep?: readonly (timeUnit)[] }): Duration<true> {
    const copy: DurationLikeObject =
        duration instanceof Duration ?
            duration.normalize().toObject() :
            Duration.fromDurationLike({ ...duration }).normalize().toObject();

    // epxands the time unit to all possible names in the duration object
    const expandTimeUnit = (unit: timeUnit) => {
        const map = {
            years: ['year', 'years'],
            months: ['month', 'months'],
            days: ['day', 'days'],
            hours: ['hour', 'hours'],
            minutes: ['minute', 'minutes'],
            seconds: ['second', 'seconds'],
            milliseconds: ['millisecond', 'milliseconds']
        } as Record<timeUnit, (keyof DurationLikeObject)[]>;
        return map[unit];
    }

    const skip = options?.skip?.flatMap(expandTimeUnit) ?? [];
    const keep = options?.keep?.flatMap(expandTimeUnit) ?? [];

    for (const key of skip) {
        delete copy[key];
    }
    const order = ['years', 'months', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'] satisfies (keyof DurationLikeObject)[];
    let foundTiming = false;
    for (const key of order) {
        if (copy[key] && !foundTiming) {
            foundTiming = true;
        } else if (!copy[key] && (!foundTiming || !keep.includes(key))) {
            delete copy[key];
        }
    }
    return Duration.fromDurationLike(copy);

}

export async function renderMarkdown(md: string): Promise<string> {
    const sanitizedHtml = await unified()
        .use(remarkParse)
        .use(remarkRehype)
        .use(rehypeSanitize)
        .use(rehypeStringify)
        .process(md);

    return String(sanitizedHtml);
}


// markdown helper
export const transformToAst = (text: string) => unified()
    .use(remarkParse)
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 30,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    }).parse(text);

export const formatMarkdown = (text: string) => unified()
    .use(remarkParse)
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 60,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    })
    .use(remarkStringify)
    .processSync(text).value as string;

export const transformFromAst = (ast: Root) => unified()
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 30,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    }).use(remarkStringify)
    .stringify(ast)
    ;

