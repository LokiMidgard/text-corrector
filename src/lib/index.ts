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
import type { NewCorrectionMetadata } from "./server/git";


type timeUnit = 'years' | 'months' | 'days' | 'hours' | 'minutes' | 'seconds' | 'milliseconds';

export type ModelConfiguration = { modelNames: string[]; styles: string[] };

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

export function getFileTotalProgress(currentState: NewCorrectionMetadata | undefined, configuredModels: ModelConfiguration) {
    return (
        (currentState?.paragraphInfo.length ?? 0) *
        (configuredModels.modelNames.length * (configuredModels.styles.length + 1) + 1)
    );
}
export function getFileProgress(currentState: NewCorrectionMetadata | undefined, configuredModels: ModelConfiguration) {
    const modelNames = new Set(configuredModels.modelNames);
    const stiles = new Set(configuredModels.styles);
    return currentState?.paragraphInfo
        .map(
            (x) =>
                Object.entries(x.judgment)
                    .filter(([key]) => modelNames.has(key))
                    .map(
                        ([, x]) =>
                            // stiele
                            Object.entries(x.text.alternative)?.filter(([key]) => stiles.has(key)).length +
                            // model corrections
                            (x.text.correction == undefined ? 0 : 1)
                    )
                    .reduce((p, c) => p + c, 0) + (x.corrected == undefined ? 0 : 1)
            //
        )
        .reduce((p, c) => p + c, 0);
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



export function msToHumanReadable(durattion_in_ms: number): string {
    const duration = reduceDuration({
        milliseconds: durattion_in_ms,
        seconds: 0,
        minutes: 0,
        hours: 0,
    }, { skip: ['milliseconds'] });
    const formattedDuration = duration.toFormat("hh:mm:ss");
    console.debug("formattedDuration", durattion_in_ms, formattedDuration);
    return formattedDuration;
}

export function bytesTohuman(params: number) {
    const bytes = params;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (params > 1024 && i < units.length - 1) {
        params /= 1024;
        i++;
    }
    return `${params.toFixed(2)} ${units[i]} (${bytes} bytes)`;
}









type Point = { x: number, y: number };

export function createAproximationFunction(points: Point[]) {

    if (points.length < 2) {
        throw new Error("At least two points are required to calculate a function.");
    }
    if (points.length == 2) {
        const [p1, p2] = points;
        const a = (p2.y - p1.y) / (p2.x - p1.x);
        const b = p1.y - a * p1.x;
        return {
            parameter: { a, b },
            f: (x: number) => a * x + b,
            inverse: (y: number) => (y - b) / a
        };
    }

    let sumX = 0, sumX2 = 0, sumX3 = 0, sumX4 = 0;
    let sumY = 0, sumXY = 0, sumX2Y = 0;
    const n = points.length;

    for (const { x, y } of points) {
        const x2 = x * x;
        const x3 = x2 * x;
        const x4 = x3 * x;

        sumX += x;
        sumX2 += x2;
        sumX3 += x3;
        sumX4 += x4;
        sumY += y;
        sumXY += x * y;
        sumX2Y += x2 * y;
    }

    // Matrix:
    // | sumX4 sumX3 sumX2 |   | a |   =   | sumX2Y |
    // | sumX3 sumX2 sumX  | * | b |   =   | sumXY  |
    // | sumX2 sumX  n     |   | c |   =   | sumY   |

    const A = [
        [sumX4, sumX3, sumX2],
        [sumX3, sumX2, sumX],
        [sumX2, sumX, n]
    ];

    const B = [sumX2Y, sumXY, sumY];

    const [a, b, c] = solveLinearSystem(A, B);
    return {
        parameter: { a, b, c },
        f: (x: number) => a * x * x + b * x + c,
        inverse: (y: number) => {
            const discriminant = b * b - 4 * a * (c - y);
            if (discriminant < 0) throw new Error('No discriminate'); // No real roots
            const sqrtDiscriminant = Math.sqrt(discriminant);
            const x1 = (-b + sqrtDiscriminant) / (2 * a);
            // we only need the positive root
            // const x2 = (-b - sqrtDiscriminant) / (2 * a);
            return x1; // Return only non-negative roots
        }
    };
}

// Solve a 3x3 linear system Ax = B
function solveLinearSystem(A: number[][], B: number[]) {
    const [a, b, c] = A;
    const det = determinant3x3(a, b, c);

    if (det === 0) throw new Error("Matrix is singular and cannot be solved.");

    const Dx = determinant3x3(B, b, c);
    const Dy = determinant3x3(a, B, c);
    const Dz = determinant3x3(a, b, B);

    return [Dx / det, Dy / det, Dz / det] as const;
}

function determinant3x3(a: number[], b: number[], c: number[]): number {
    return (
        a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])
    );
}
