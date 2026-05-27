declare module 'pokersolver' {
  export const Hand: {
    solve(cards: string[]): {
      name: string;
      descr: string;
      [key: string]: unknown;
    };
    winners(hands: unknown[]): unknown[];
    [key: string]: unknown;
  };
}