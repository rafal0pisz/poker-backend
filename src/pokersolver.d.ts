declare module 'pokersolver' {
  export const Hand: {
    solve(cards: string[]): {
      name: string;
      descr: string;
      cards?: Array<{ value: string; suit: string } | string>;
      [key: string]: unknown;
    };
    winners(hands: unknown[]): Array<{
      cards?: Array<{ value: string; suit: string } | string>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
}
