// ツールで使う Node API の最小限の型(@types/node を入れずに済ませるため)
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
}
