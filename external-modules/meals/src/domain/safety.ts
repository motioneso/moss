// external-modules/meals/src/domain/safety.ts
//
// The deterministic half of the Safety check, and the brand rule. The rule runs first and is
// conservative: a false failure costs one regeneration, a false pass could serve an unsafe meal.

import type { StoreSection } from "../contracts.js";

export interface IngredientDraft {
  readonly originalText: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly section: StoreSection;
  readonly checkLabel: boolean;
}

export type SafetyVerdict =
  | { readonly verdict: "pass" }
  | { readonly verdict: "fail"; readonly reason: string };

const MAX_REASON = 200;

const MEAT = [
  "meat",
  "chicken",
  "beef",
  "pork",
  "lamb",
  "mutton",
  "veal",
  "venison",
  "duck",
  "goose",
  "turkey",
  "bacon",
  "ham",
  "prosciutto",
  "pancetta",
  "chorizo",
  "salami",
  "pepperoni",
  "sausage",
  "steak",
  "mince",
  "gelatin",
  "gelatine",
  "lard",
  "suet",
  "anchovy",
  "anchovies"
];
const FISH = [
  "fish",
  "salmon",
  "tuna",
  "cod",
  "haddock",
  "trout",
  "mackerel",
  "sardine",
  "sardines",
  "anchovy",
  "anchovies",
  "halibut",
  "tilapia",
  "pollock",
  "bass",
  "fish sauce"
];
const SHELLFISH = [
  "shellfish",
  "shrimp",
  "prawn",
  "prawns",
  "crab",
  "lobster",
  "crayfish",
  "clam",
  "clams",
  "mussel",
  "mussels",
  "oyster",
  "oysters",
  "scallop",
  "scallops",
  "squid",
  "octopus"
];
const DAIRY = [
  "dairy",
  "milk",
  "cheese",
  "butter",
  "cream",
  "yogurt",
  "yoghurt",
  "ghee",
  "whey",
  "casein",
  "feta",
  "parmesan",
  "mozzarella",
  "cheddar",
  "ricotta",
  "paneer",
  "halloumi",
  "custard"
];
const EGG = ["egg", "eggs", "mayonnaise", "mayo", "meringue"];
const GLUTEN = [
  "gluten",
  "wheat",
  "flour",
  "bread",
  "breadcrumbs",
  "pasta",
  "spaghetti",
  "noodles",
  "couscous",
  "barley",
  "rye",
  "bulgur",
  "semolina",
  "seitan",
  "soy sauce",
  "tortilla",
  "pita",
  "cracker",
  "crackers",
  "panko",
  "orzo",
  "farro",
  "spelt"
];
const TREE_NUTS = [
  "almond",
  "almonds",
  "walnut",
  "walnuts",
  "cashew",
  "cashews",
  "pecan",
  "pecans",
  "pistachio",
  "pistachios",
  "hazelnut",
  "hazelnuts",
  "macadamia",
  "brazil nut",
  "pine nut",
  "pine nuts",
  "praline",
  "marzipan"
];
const PEANUT = ["peanut", "peanuts", "groundnut", "satay"];
const PORK = ["pork", "bacon", "ham", "prosciutto", "pancetta", "chorizo", "salami", "lard"];
const ALCOHOL = ["alcohol", "wine", "beer", "rum", "vodka", "brandy", "sherry", "bourbon", "sake"];

/** Diet words and common allergen names, each mapped to the terms it rules out. */
const EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  vegetarian: [...MEAT, ...FISH, ...SHELLFISH],
  vegan: [...MEAT, ...FISH, ...SHELLFISH, ...DAIRY, ...EGG, "honey"],
  pescatarian: MEAT,
  dairy: DAIRY,
  lactose: DAIRY,
  gluten: GLUTEN,
  wheat: GLUTEN,
  coeliac: GLUTEN,
  celiac: GLUTEN,
  egg: EGG,
  eggs: EGG,
  shellfish: SHELLFISH,
  fish: [...FISH, ...SHELLFISH],
  seafood: [...FISH, ...SHELLFISH],
  "tree nut": TREE_NUTS,
  "tree nuts": TREE_NUTS,
  nut: [...TREE_NUTS, ...PEANUT, "nut", "nuts"],
  nuts: [...TREE_NUTS, ...PEANUT, "nut", "nuts"],
  peanut: PEANUT,
  peanuts: PEANUT,
  pork: PORK,
  halal: [...PORK, ...ALCOHOL],
  kosher: [...PORK, ...SHELLFISH],
  alcohol: ALCOHOL,
  meat: MEAT,
  beef: ["beef", "steak", "veal"],
  soy: ["soy", "soya", "tofu", "tempeh", "edamame", "miso", "soy sauce"],
  sesame: ["sesame", "tahini"]
};

const LEADING_NEGATION = /^(?:no|never|without|avoid|avoids|allergic to|allergy to|not)\s+/;

/** Words people put after the food, as in "peanut allergy", "nut-free", "lactose intolerant". */
const TRAILING_QUALIFIER =
  /\s+(?:allergy|allergies|allergic|intolerance|intolerant|sensitivity|sensitive|free)$/;

function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The terms one restriction rules out, including simple plural and singular forms. */
function restrictionTerms(restriction: string): readonly string[] {
  const phrase = normalise(restriction)
    .replace(LEADING_NEGATION, "")
    .replace(TRAILING_QUALIFIER, "");
  if (phrase === "") return [];
  const terms = EXPANSIONS[phrase] ?? [phrase];
  return terms.flatMap((term) => {
    const base = normalise(term);
    return base.endsWith("s") ? [base, base.slice(0, -1)] : [base, `${base}s`, `${base}es`];
  });
}

function containsTerm(haystack: string, term: string): boolean {
  return ` ${haystack} `.includes(` ${term} `);
}

export function deterministicSafety(
  ingredients: readonly IngredientDraft[],
  restrictions: readonly string[]
): SafetyVerdict {
  for (const restriction of restrictions) {
    const terms = restrictionTerms(restriction);
    for (const line of ingredients) {
      const text = `${normalise(line.name)} ${normalise(line.originalText)}`;
      const hit = terms.find((term) => containsTerm(text, term));
      if (hit !== undefined) {
        const reason = `${line.name} conflicts with "${restriction}"`;
        return { verdict: "fail", reason: reason.slice(0, MAX_REASON) };
      }
    }
  }
  return { verdict: "pass" };
}

/** The model can add a failure but never clear the rule's. */
export function mergeSafety(rule: SafetyVerdict, model: SafetyVerdict | null): SafetyVerdict {
  if (rule.verdict === "fail") return rule;
  if (model?.verdict === "fail")
    return { verdict: "fail", reason: model.reason.slice(0, MAX_REASON) };
  return rule;
}

const BRAND_MARK = /[™®©]/;
const POSSESSIVE_BRAND = /\b\p{Lu}[\p{L}]*'s\b/u;
const PACKAGED = [
  "jar",
  "jarred",
  "can",
  "canned",
  "tin",
  "tinned",
  "bottle",
  "bottled",
  "packet",
  "pack",
  "package",
  "packaged",
  "carton",
  "box",
  "boxed",
  "store bought",
  "shop bought",
  "ready made",
  "premade",
  "pre made",
  "instant",
  "stock cube",
  "bouillon",
  "brand",
  "frozen",
  "mix"
];

/** True when a line names a brand or a packaged product, whose label must be read. */
export function brandRule(originalText: string): boolean {
  if (BRAND_MARK.test(originalText) || POSSESSIVE_BRAND.test(originalText)) return true;
  const text = normalise(originalText);
  if (PACKAGED.some((word) => containsTerm(text, word) || containsTerm(text, `${word}s`))) {
    return true;
  }
  // A capitalised word after the first one is most likely a brand name.
  const words = originalText.trim().split(/\s+/).slice(1);
  return words.some((word) => /^\p{Lu}\p{Ll}+/u.test(word));
}

/** Adds the brand flag. A flag the model set is always kept. */
export function applyBrandRule(
  ingredients: readonly IngredientDraft[]
): readonly IngredientDraft[] {
  return ingredients.map((line) =>
    line.checkLabel || brandRule(line.originalText) ? { ...line, checkLabel: true } : line
  );
}
