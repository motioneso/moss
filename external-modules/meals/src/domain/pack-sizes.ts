// external-modules/meals/src/domain/pack-sizes.ts
//
// Common shop pack sizes by ingredient name key, smallest first. A purchase amount rounds up to
// the smallest pack that covers the need, or to whole copies of the largest pack. Names missing
// here buy the raw amount.

export interface PackSize {
  readonly quantity: number;
  readonly unit: string;
}

export const PACK_SIZES: Readonly<Record<string, readonly PackSize[]>> = {
  milk: [
    { quantity: 500, unit: "ml" },
    { quantity: 1000, unit: "ml" },
    { quantity: 2000, unit: "ml" }
  ],
  cream: [
    { quantity: 250, unit: "ml" },
    { quantity: 500, unit: "ml" }
  ],
  butter: [
    { quantity: 250, unit: "g" },
    { quantity: 500, unit: "g" }
  ],
  flour: [
    { quantity: 1000, unit: "g" },
    { quantity: 2000, unit: "g" }
  ],
  sugar: [{ quantity: 1000, unit: "g" }],
  rice: [
    { quantity: 500, unit: "g" },
    { quantity: 1000, unit: "g" }
  ],
  pasta: [{ quantity: 500, unit: "g" }],
  oats: [{ quantity: 500, unit: "g" }],
  yogurt: [
    { quantity: 170, unit: "g" },
    { quantity: 500, unit: "g" }
  ],
  cheese: [{ quantity: 200, unit: "g" }],
  "olive oil": [
    { quantity: 250, unit: "ml" },
    { quantity: 500, unit: "ml" },
    { quantity: 1000, unit: "ml" }
  ],
  "chicken stock": [{ quantity: 1000, unit: "ml" }],
  "canned tomatoes": [{ quantity: 400, unit: "g" }],
  "coconut milk": [{ quantity: 400, unit: "ml" }]
};
