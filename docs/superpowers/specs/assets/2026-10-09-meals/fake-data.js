// Fake data for the Meals prototype. Canned records only: no AI, storage or network.
/* global window */

(function () {
  // Fixed "today" so every review sees the same week.
  const TODAY = "2026-11-04";

  const members = [
    {
      id: "m-ben",
      name: "Ben",
      isSelf: true,
      pattern: ["Breakfast", "Lunch", "Dinner"],
      restrictions: ["Shellfish"],
      preferences: ["Spicy food", "Mexican", "Less red meat"],
      target: 2200,
      linkedAccount: null
    },
    {
      id: "m-maya",
      name: "Maya",
      isSelf: false,
      pattern: ["Lunch", "Dinner", "Post-gym"],
      restrictions: ["Tree nuts"],
      preferences: ["Mediterranean", "Mushrooms", "No coriander"],
      target: 1800,
      linkedAccount: "maya@example.com"
    }
  ];

  const slotRules = [
    { slot: "Breakfast", rule: "shared", soloDays: [] },
    { slot: "Lunch", rule: "solo", soloDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
    { slot: "Dinner", rule: "shared", soloDays: [] },
    { slot: "Post-gym", rule: "shared", soloDays: [] }
  ];

  const ing = (text, qty, unit, name, section, extra) =>
    Object.assign({ text, qty, unit, name, section }, extra || {});

  const recipes = {
    "r-oats": {
      title: "Overnight oats with berries",
      minutes: 5,
      baseServings: 1,
      kcal: 420,
      source: "generated",
      ingredients: [
        ing("1/2 cup rolled oats", 0.5, "cup", "rolled oats", "Pantry"),
        ing("2/3 cup milk", 0.67, "cup", "milk", "Dairy and eggs"),
        ing("1/2 cup mixed berries", 0.5, "cup", "mixed berries", "Frozen"),
        ing("1 tbsp chia seeds", 1, "tbsp", "chia seeds", "Pantry"),
        ing("1 tsp honey", 1, "tsp", "honey", "Pantry")
      ],
      steps: [
        "Stir the oats, milk and chia seeds together in a jar.",
        "Top with berries and honey, cover and chill overnight."
      ]
    },
    "r-huevos": {
      title: "Huevos rancheros",
      minutes: 20,
      baseServings: 1,
      kcal: 560,
      source: "generated",
      ingredients: [
        ing("2 eggs", 2, "", "eggs", "Dairy and eggs"),
        ing("2 corn tortillas", 2, "", "corn tortillas", "Bakery"),
        ing("1/2 cup black beans, drained", 0.5, "cup", "black beans", "Pantry"),
        ing("1/3 cup salsa roja", 0.33, "cup", "salsa roja", "Pantry"),
        ing("1/4 avocado", 0.25, "", "avocado", "Produce")
      ],
      steps: [
        "Warm the beans and salsa in a small pan.",
        "Fry the eggs. Warm the tortillas in a dry pan.",
        "Layer tortillas, beans and eggs. Top with avocado."
      ]
    },
    "r-pancakes": {
      title: "Ricotta pancakes with lemon",
      minutes: 25,
      baseServings: 1,
      kcal: 610,
      source: "favourite",
      ingredients: [
        ing("1/2 cup ricotta", 0.5, "cup", "ricotta", "Dairy and eggs"),
        ing("1 egg", 1, "", "eggs", "Dairy and eggs"),
        ing("1/3 cup flour", 0.33, "cup", "flour", "Pantry"),
        ing("1/2 lemon, zested", 0.5, "", "lemons", "Produce")
      ],
      steps: ["Whisk the batter.", "Cook small pancakes in butter.", "Finish with lemon zest."]
    },
    "r-burrito": {
      title: "Chicken burrito bowl",
      minutes: 30,
      baseServings: 3,
      kcal: 640,
      source: "generated",
      ingredients: [
        ing("1 lb chicken breast", 1, "lb", "chicken breast", "Meat and fish"),
        ing("1 cup long-grain rice", 1, "cup", "rice", "Pantry"),
        ing("1 can black beans", 1, "can", "black beans", "Pantry"),
        ing("1 cup corn kernels", 1, "cup", "corn", "Frozen"),
        ing("2 limes", 2, "", "limes", "Produce"),
        ing("1 tbsp chipotle in adobo", 1, "tbsp", "chipotle in adobo", "Pantry")
      ],
      steps: [
        "Cook the rice.",
        "Season and sear the chicken, then slice.",
        "Warm beans and corn. Build three bowls and squeeze over lime."
      ]
    },
    "r-soup": {
      title: "Smoky black bean soup",
      minutes: 35,
      baseServings: 2,
      kcal: 520,
      source: "generated",
      ingredients: [
        ing("2 cans black beans", 2, "can", "black beans", "Pantry"),
        ing("1 onion, diced", 1, "", "onions", "Produce"),
        ing("3 cloves garlic", 3, "clove", "garlic", "Produce"),
        ing("1 tsp smoked paprika", 1, "tsp", "smoked paprika", "Pantry"),
        ing("3 cups vegetable stock", 3, "cup", "vegetable stock", "Pantry")
      ],
      steps: ["Soften onion and garlic.", "Add beans, paprika and stock.", "Simmer and blend half."]
    },
    "r-halloumi": {
      title: "Halloumi and roast pepper grain salad",
      minutes: 25,
      baseServings: 3,
      kcal: 560,
      source: "generated",
      ingredients: [
        ing("8 oz halloumi", 8, "oz", "halloumi", "Dairy and eggs"),
        ing("1 cup farro", 1, "cup", "farro", "Pantry"),
        ing("2 red peppers", 2, "", "red peppers", "Produce"),
        ing("1 lemon", 1, "", "lemons", "Produce"),
        ing("A handful of parsley", null, "", "parsley", "Produce")
      ],
      steps: ["Cook the farro.", "Roast the peppers.", "Fry the halloumi and toss together."]
    },
    "r-farro": {
      title: "Mushroom and farro bowl",
      minutes: 30,
      baseServings: 2,
      kcal: 540,
      source: "generated",
      ingredients: [
        ing("10 oz cremini mushrooms", 10, "oz", "cremini mushrooms", "Produce"),
        ing("3/4 cup farro", 0.75, "cup", "farro", "Pantry"),
        ing("2 cups baby spinach", 2, "cup", "baby spinach", "Produce"),
        ing("2 tbsp tahini", 2, "tbsp", "tahini", "Pantry")
      ],
      steps: ["Cook the farro.", "Sear the mushrooms hard.", "Wilt the spinach and dress with tahini."]
    },
    "r-traybake": {
      title: "Lemon chicken traybake",
      minutes: 45,
      baseServings: 2,
      kcal: 690,
      source: "favourite",
      ingredients: [
        ing("1 1/2 lb bone-in chicken thighs", 1.5, "lb", "chicken thighs", "Meat and fish"),
        ing("1 lb baby potatoes, halved", 1, "lb", "baby potatoes", "Produce"),
        ing("2 lemons, quartered", 2, "", "lemons", "Produce"),
        ing("1 red onion, in wedges", 1, "", "red onions", "Produce"),
        ing("4 cloves garlic, smashed", 4, "clove", "garlic", "Produce"),
        ing("2 tbsp olive oil", 2, "tbsp", "olive oil", "Pantry"),
        ing("1 tsp dried oregano", 1, "tsp", "dried oregano", "Pantry")
      ],
      steps: [
        "Heat the oven to 425°F.",
        "Toss everything with the oil, oregano and plenty of salt in one large tray.",
        "Roast for 40 minutes, turning the potatoes once, until the chicken skin is crisp.",
        "Squeeze the roasted lemon over before serving."
      ]
    },
    "r-tacos": {
      title: "Black bean tacos with lime slaw",
      minutes: 25,
      baseServings: 2,
      kcal: 640,
      source: "favourite",
      ingredients: [
        ing("8 Old El Paso hard taco shells", 8, "", "taco shells", "Pantry", {
          checkLabel: true
        }),
        ing("2 cans black beans", 2, "can", "black beans", "Pantry"),
        ing("1/4 red cabbage, shredded", 0.25, "", "red cabbage", "Produce"),
        ing("2 limes", 2, "", "limes", "Produce"),
        ing("1/2 cup sour cream", 0.5, "cup", "sour cream", "Dairy and eggs"),
        ing("1 jalapeño", 1, "", "jalapeños", "Produce")
      ],
      steps: [
        "Warm the beans with cumin and a splash of water, then mash a few.",
        "Toss the cabbage with lime juice and salt.",
        "Fill the shells and top with slaw, jalapeño and sour cream."
      ]
    },
    "r-salmon": {
      title: "Miso salmon with sesame greens",
      minutes: 25,
      baseServings: 2,
      kcal: 610,
      source: "generated",
      ingredients: [
        ing("2 salmon fillets (6 oz each)", 12, "oz", "salmon fillets", "Meat and fish"),
        ing("2 tbsp white miso", 2, "tbsp", "white miso", "Pantry"),
        ing("1 tbsp honey", 1, "tbsp", "honey", "Pantry"),
        ing("8 oz green beans", 8, "oz", "green beans", "Produce"),
        ing("1 head bok choy", 1, "", "bok choy", "Produce"),
        ing("1 tsp toasted sesame oil", 1, "tsp", "sesame oil", "Pantry"),
        ing("1 cup jasmine rice", 1, "cup", "rice", "Pantry")
      ],
      steps: [
        "Cook the rice.",
        "Mix the miso and honey and brush over the salmon.",
        "Grill the salmon for 8 minutes until it flakes.",
        "Stir-fry the greens in sesame oil and serve with the rice."
      ]
    },
    "r-stroganoff": {
      title: "Mushroom stroganoff",
      minutes: 25,
      baseServings: 2,
      kcal: 620,
      source: "generated",
      ingredients: [
        ing("1 lb cremini mushrooms, sliced", 1, "lb", "cremini mushrooms", "Produce"),
        ing("1 onion, sliced", 1, "", "onions", "Produce"),
        ing("2/3 cup sour cream", 0.67, "cup", "sour cream", "Dairy and eggs"),
        ing("8 oz egg noodles", 8, "oz", "egg noodles", "Pantry"),
        ing("1 tsp paprika", 1, "tsp", "paprika", "Pantry")
      ],
      steps: ["Brown the mushrooms in batches.", "Soften the onion.", "Stir in sour cream and serve on noodles."]
    },
    "r-curry": {
      title: "Chickpea and spinach curry",
      minutes: 35,
      baseServings: 2,
      kcal: 580,
      source: "generated",
      ingredients: [
        ing("2 tbsp Patak's mild curry paste", 2, "tbsp", "curry paste", "Pantry", {
          checkLabel: true
        }),
        ing("2 cans chickpeas", 2, "can", "chickpeas", "Pantry"),
        ing("1 can coconut milk", 1, "can", "coconut milk", "Pantry"),
        ing("5 oz baby spinach", 5, "oz", "baby spinach", "Produce"),
        ing("1 onion", 1, "", "onions", "Produce"),
        ing("1 cup basmati rice", 1, "cup", "rice", "Pantry")
      ],
      steps: ["Fry the onion and curry paste.", "Add chickpeas and coconut milk.", "Wilt in the spinach."]
    },
    "r-flatbread": {
      title: "Margherita flatbreads",
      minutes: 20,
      baseServings: 2,
      kcal: 650,
      source: "generated",
      ingredients: [
        ing("2 naan flatbreads", 2, "", "naan", "Bakery"),
        ing("1/2 cup Rao's marinara", 0.5, "cup", "marinara sauce", "Pantry", {
          checkLabel: true
        }),
        ing("8 oz fresh mozzarella", 8, "oz", "mozzarella", "Dairy and eggs"),
        ing("A few basil leaves", null, "", "basil", "Produce")
      ],
      steps: ["Heat the oven to 450°F.", "Top the flatbreads.", "Bake for 10 minutes."]
    },
    "r-roast": {
      title: "Roast chicken with root vegetables",
      minutes: 90,
      baseServings: 4,
      kcal: 720,
      source: "generated",
      ingredients: [
        ing("1 whole chicken (4 lb)", 4, "lb", "whole chicken", "Meat and fish"),
        ing("1 lb carrots", 1, "lb", "carrots", "Produce"),
        ing("1 lb parsnips", 1, "lb", "parsnips", "Produce"),
        ing("2 onions", 2, "", "onions", "Produce"),
        ing("3 tbsp olive oil", 3, "tbsp", "olive oil", "Pantry")
      ],
      steps: ["Heat the oven to 400°F.", "Roast the chicken on the vegetables.", "Rest for 15 minutes."]
    },
    "r-yoghurt": {
      title: "Greek yoghurt with honey and oats",
      minutes: 3,
      baseServings: 1,
      kcal: 310,
      source: "generated",
      ingredients: [
        ing("1 cup Greek yoghurt", 1, "cup", "Greek yoghurt", "Dairy and eggs"),
        ing("2 tbsp rolled oats", 2, "tbsp", "rolled oats", "Pantry"),
        ing("1 tsp honey", 1, "tsp", "honey", "Pantry")
      ],
      steps: ["Spoon the yoghurt into a bowl and top with oats and honey."]
    },
    // Swap, quick swap and regenerate candidates.
    "r-shakshuka": {
      title: "Shakshuka with feta",
      minutes: 25,
      baseServings: 2,
      kcal: 540,
      source: "generated",
      ingredients: [
        ing("1 can crushed tomatoes", 1, "can", "crushed tomatoes", "Pantry"),
        ing("4 eggs", 4, "", "eggs", "Dairy and eggs"),
        ing("2 oz feta", 2, "oz", "feta", "Dairy and eggs"),
        ing("1 red pepper", 1, "", "red peppers", "Produce")
      ],
      steps: ["Soften the pepper.", "Add tomatoes and simmer.", "Crack in the eggs and cover."]
    },
    "r-gnocchi": {
      title: "Crispy gnocchi with peas and lemon",
      minutes: 15,
      baseServings: 2,
      kcal: 590,
      source: "generated",
      ingredients: [
        ing("1 lb shelf-stable gnocchi", 1, "lb", "gnocchi", "Pantry"),
        ing("1 cup frozen peas", 1, "cup", "peas", "Frozen"),
        ing("1 lemon", 1, "", "lemons", "Produce"),
        ing("2 oz parmesan", 2, "oz", "parmesan", "Dairy and eggs")
      ],
      steps: ["Pan-fry the gnocchi until crisp.", "Add peas.", "Finish with lemon and parmesan."]
    },
    "r-friedrice": {
      title: "Egg fried rice with greens",
      minutes: 15,
      baseServings: 2,
      kcal: 560,
      source: "generated",
      ingredients: [
        ing("2 cups cooked rice", 2, "cup", "rice", "Pantry"),
        ing("3 eggs", 3, "", "eggs", "Dairy and eggs"),
        ing("1 head bok choy", 1, "", "bok choy", "Produce"),
        ing("2 scallions", 2, "", "scallions", "Produce")
      ],
      steps: ["Scramble the eggs.", "Fry the rice hot.", "Toss in greens and scallions."]
    },
    "r-orzo": {
      title: "Lemon orzo with roast vegetables",
      minutes: 35,
      baseServings: 2,
      kcal: 600,
      source: "generated",
      ingredients: [
        ing("8 oz orzo", 8, "oz", "orzo", "Pantry"),
        ing("1 zucchini", 1, "", "zucchini", "Produce"),
        ing("1 cup cherry tomatoes", 1, "cup", "cherry tomatoes", "Produce")
      ],
      steps: ["Roast the vegetables.", "Cook the orzo.", "Toss with lemon and olive oil."]
    }
  };

  // Calorie fit per eater, in kcal, against that eater's share of their day target.
  const fit = (entries) => entries.map(([memberId, kcal, share]) => ({ memberId, kcal, share }));

  const meal = (id, slot, recipeId, eaters, extra) =>
    Object.assign(
      {
        id,
        slot,
        kind: "recipe",
        recipeId,
        eaters,
        sharing: eaters.length > 1 ? "shared" : "solo",
        locked: false,
        cooked: false,
        favouriteOf: null,
        servingsOverride: null,
        fit: [],
        text: null
      },
      extra || {}
    );

  const textMeal = (id, slot, text, eaters) =>
    Object.assign(meal(id, slot, null, eaters), { kind: "text", text });

  const BOTH = ["m-ben", "m-maya"];
  const BEN = ["m-ben"];
  const MAYA = ["m-maya"];

  const days = [
    {
      date: "2026-11-02",
      cookLimit: null,
      lunchOverride: null,
      meals: [
        meal("p1", "Breakfast", "r-oats", BEN, { cooked: true, fit: fit([["m-ben", 420, 440]]) }),
        meal("p2", "Lunch", "r-burrito", BEN, { cooked: true, fit: fit([["m-ben", 640, 660]]) }),
        meal("p3", "Lunch", "r-halloumi", MAYA, { cooked: true, fit: fit([["m-maya", 560, 630]]) }),
        meal("p4", "Dinner", "r-traybake", BOTH, {
          locked: true,
          cooked: true,
          favouriteOf: "m-maya",
          fit: fit([
            ["m-ben", 860, 880],
            ["m-maya", 690, 720]
          ])
        }),
        meal("p5", "Post-gym", "r-yoghurt", MAYA, { cooked: true, fit: fit([["m-maya", 310, 450]]) })
      ]
    },
    {
      date: "2026-11-03",
      cookLimit: null,
      lunchOverride: null,
      meals: [
        meal("p6", "Breakfast", "r-oats", BEN, { cooked: true, fit: fit([["m-ben", 420, 440]]) }),
        meal("p7", "Lunch", "r-burrito", BEN, { cooked: true, fit: fit([["m-ben", 640, 660]]) }),
        meal("p8", "Lunch", "r-halloumi", MAYA, { cooked: true, fit: fit([["m-maya", 560, 630]]) }),
        meal("p9", "Dinner", "r-tacos", BOTH, {
          cooked: true,
          favouriteOf: "m-ben",
          fit: fit([
            ["m-ben", 910, 880],
            ["m-maya", 640, 720]
          ])
        }),
        meal("p10", "Post-gym", "r-yoghurt", MAYA, { cooked: true, fit: fit([["m-maya", 310, 450]]) })
      ]
    },
    {
      date: "2026-11-04",
      cookLimit: null,
      lunchOverride: null,
      meals: [
        meal("p11", "Breakfast", "r-oats", BEN, { cooked: true, fit: fit([["m-ben", 420, 440]]) }),
        meal("p12", "Lunch", "r-burrito", BEN, { fit: fit([["m-ben", 640, 660]]) }),
        meal("p13", "Lunch", "r-farro", MAYA, { fit: fit([["m-maya", 540, 630]]) }),
        meal("p14", "Dinner", "r-salmon", BOTH, {
          fit: fit([
            ["m-ben", 820, 880],
            ["m-maya", 610, 720]
          ])
        }),
        meal("p15", "Post-gym", "r-yoghurt", MAYA, { fit: fit([["m-maya", 310, 450]]) })
      ]
    },
    {
      date: "2026-11-05",
      cookLimit: 30,
      lunchOverride: null,
      meals: [
        meal("p16", "Breakfast", "r-oats", BEN, { fit: fit([["m-ben", 420, 440]]) }),
        meal("p17", "Lunch", "r-soup", BEN, { fit: fit([["m-ben", 620, 660]]) }),
        meal("p18", "Lunch", "r-farro", MAYA, { fit: fit([["m-maya", 540, 630]]) }),
        meal("p19", "Dinner", "r-stroganoff", BOTH, {
          fit: fit([
            ["m-ben", 840, 880],
            ["m-maya", 620, 720]
          ])
        }),
        meal("p20", "Post-gym", "r-yoghurt", MAYA, { fit: fit([["m-maya", 310, 450]]) })
      ]
    },
    {
      date: "2026-11-06",
      cookLimit: null,
      lunchOverride: null,
      meals: [
        meal("p21", "Breakfast", "r-oats", BEN, { fit: fit([["m-ben", 420, 440]]) }),
        meal("p22", "Lunch", "r-soup", BEN, { fit: fit([["m-ben", 620, 660]]) }),
        meal("p23", "Lunch", "r-halloumi", MAYA, { fit: fit([["m-maya", 560, 630]]) }),
        textMeal("p24", "Dinner", "Eating out", BOTH),
        meal("p25", "Post-gym", "r-yoghurt", MAYA, { fit: fit([["m-maya", 310, 450]]) })
      ]
    },
    {
      date: "2026-11-07",
      cookLimit: null,
      lunchOverride: "shared",
      meals: [
        meal("p26", "Breakfast", "r-huevos", BEN, { fit: fit([["m-ben", 560, 440]]) }),
        meal("p27", "Lunch", "r-flatbread", BOTH, {
          fit: fit([
            ["m-ben", 700, 660],
            ["m-maya", 600, 630]
          ])
        }),
        meal("p28", "Dinner", "r-curry", BOTH, {
          fit: fit([
            ["m-ben", 780, 880],
            ["m-maya", 580, 720]
          ])
        }),
        meal("p29", "Post-gym", "r-yoghurt", MAYA, { fit: fit([["m-maya", 310, 450]]) })
      ]
    },
    {
      date: "2026-11-08",
      cookLimit: null,
      lunchOverride: "shared",
      meals: [
        meal("p30", "Breakfast", "r-pancakes", BEN, {
          favouriteOf: "m-ben",
          fit: fit([["m-ben", 610, 440]])
        }),
        textMeal("p31", "Lunch", "Leftovers", BOTH),
        meal("p32", "Dinner", "r-roast", BOTH, {
          fit: fit([
            ["m-ben", 880, 880],
            ["m-maya", 700, 720]
          ])
        }),
        meal("p33", "Post-gym", "r-yoghurt", MAYA, { fit: fit([["m-maya", 310, 450]]) })
      ]
    }
  ];

  const plan = {
    id: "plan-45",
    start: "2026-11-02",
    pantryMode: "prefer",
    writtenBy: "Claude Sonnet",
    request: "Meal prep breakfasts and weekday lunches. Bring back Maya's traybake.",
    days
  };

  // Swap and regenerate candidates per slot kind.
  const swapPool = {
    Dinner: ["r-shakshuka", "r-gnocchi", "r-orzo", "r-friedrice"],
    Lunch: ["r-shakshuka", "r-orzo", "r-halloumi"],
    Breakfast: ["r-huevos", "r-pancakes", "r-oats"],
    "Post-gym": ["r-yoghurt", "r-oats"]
  };

  const pantry = [
    { id: "pi1", name: "Rice", qty: 3, unit: "lb", section: "Pantry", source: "bought", updated: "2 days ago" },
    { id: "pi2", name: "Rolled oats", qty: null, unit: "", section: "Pantry", source: "manual", updated: "last week" },
    { id: "pi3", name: "Eggs", qty: 9, unit: "", section: "Dairy and eggs", source: "bought", updated: "2 days ago" },
    { id: "pi4", name: "Milk", qty: 0.5, unit: "gal", section: "Dairy and eggs", source: "bought", updated: "2 days ago" },
    { id: "pi5", name: "Black beans", qty: 3, unit: "can", section: "Pantry", source: "receipt", updated: "Sunday" },
    { id: "pi6", name: "Olive oil", qty: null, unit: "", section: "Pantry", source: "manual", updated: "last week" },
    { id: "pi7", name: "Garlic", qty: 1, unit: "head", section: "Produce", source: "bought", updated: "2 days ago" },
    { id: "pi8", name: "Onions", qty: 2, unit: "", section: "Produce", source: "bought", updated: "2 days ago" },
    { id: "pi9", name: "Lemons", qty: 1, unit: "", section: "Produce", source: "bought", updated: "2 days ago" },
    { id: "pi10", name: "Lemon chicken traybake", qty: 2, unit: "portions", section: "Leftovers", source: "leftover", updated: "Monday" },
    { id: "pi11", name: "Honey", qty: null, unit: "", section: "Pantry", source: "manual", updated: "last month" },
    { id: "pi12", name: "Greek yoghurt", qty: 32, unit: "oz", section: "Dairy and eggs", source: "bought", updated: "2 days ago" },
    { id: "pi13", name: "Farro", qty: 1, unit: "lb", section: "Pantry", source: "bought", updated: "2 days ago" },
    { id: "pi14", name: "Mixed berries", qty: 1, unit: "bag", section: "Frozen", source: "bought", updated: "2 days ago" },
    { id: "pi15", name: "Smoked paprika", qty: null, unit: "", section: "Pantry", source: "manual", updated: "last month" },
    { id: "pi16", name: "Sour cream", qty: 8, unit: "oz", section: "Dairy and eggs", source: "bought", updated: "2 days ago" }
  ];

  const staples = [
    { id: "s1", name: "Olive oil", target: null, onHand: true },
    { id: "s2", name: "Eggs", target: "12", onHand: true },
    { id: "s3", name: "Milk", target: "1 gal", onHand: true },
    { id: "s4", name: "Garlic", target: null, onHand: true },
    { id: "s5", name: "Onions", target: "3", onHand: true },
    { id: "s6", name: "Rice", target: null, onHand: true },
    { id: "s7", name: "Butter", target: null, onHand: false },
    { id: "s8", name: "Bread", target: "1 loaf", onHand: false }
  ];

  // Shopping list built from the plan, minus the Pantry, rounded to Purchase amounts.
  const line = (id, name, need, buy, section, sources, extra) =>
    Object.assign(
      { id, name, need, buy, section, sources, manual: false, staple: false, checked: false, checkLabel: false },
      extra || {}
    );

  const list = [
    line("l1", "Cremini mushrooms", "1 lb 10 oz", "2 × 1 lb packs", "Produce", ["Mushroom stroganoff", "Mushroom and farro bowl"]),
    line("l2", "Baby spinach", "7 oz", "1 × 10 oz bag", "Produce", ["Chickpea and spinach curry", "Mushroom and farro bowl"]),
    line("l3", "Limes", "2", "2", "Produce", ["Chicken burrito bowl"], { checked: true }),
    line("l4", "Carrots", "1 lb", "1 × 2 lb bag", "Produce", ["Roast chicken with root vegetables"]),
    line("l5", "Parsnips", "1 lb", "1 lb", "Produce", ["Roast chicken with root vegetables"]),
    line("l6", "Red peppers", "2", "2", "Produce", ["Halloumi and roast pepper grain salad"]),
    line("l7", "Bok choy", "1 head", "1 head", "Produce", ["Miso salmon with sesame greens"], { checked: true }),
    line("l8", "Green beans", "8 oz", "1 × 12 oz bag", "Produce", ["Miso salmon with sesame greens"], { checked: true }),
    line("l9", "Basil", "a few leaves", "1 bunch", "Produce", ["Margherita flatbreads"]),
    line("l10", "Whole chicken", "4 lb", "1 × 4 lb bird", "Meat and fish", ["Roast chicken with root vegetables"]),
    line("l11", "Salmon fillets", "12 oz", "2 fillets", "Meat and fish", ["Miso salmon with sesame greens"], { checked: true }),
    line("l12", "Fresh mozzarella", "8 oz", "1 × 8 oz ball", "Dairy and eggs", ["Margherita flatbreads"]),
    line("l13", "Halloumi", "8 oz", "1 × 8 oz block", "Dairy and eggs", ["Halloumi and roast pepper grain salad"]),
    line("l14", "Sour cream", "2/3 cup", "1 × 8 oz tub", "Dairy and eggs", ["Mushroom stroganoff"]),
    line("l15", "Naan flatbreads", "2", "1 × 2 pack", "Bakery", ["Margherita flatbreads"]),
    line("l16", "Chickpeas", "2 cans", "2 × 15 oz cans", "Pantry", ["Chickpea and spinach curry"]),
    line("l17", "Coconut milk", "1 can", "1 × 13.5 oz can", "Pantry", ["Chickpea and spinach curry"]),
    line("l18", "Curry paste", "2 tbsp", "1 jar", "Pantry", ["Chickpea and spinach curry"], { checkLabel: true }),
    line("l19", "Marinara sauce", "1/2 cup", "1 × 24 oz jar", "Pantry", ["Margherita flatbreads"], { checkLabel: true }),
    line("l20", "Egg noodles", "8 oz", "1 × 12 oz bag", "Pantry", ["Mushroom stroganoff"]),
    line("l21", "White miso", "2 tbsp", "1 tub", "Pantry", ["Miso salmon with sesame greens"], { checked: true }),
    line("l22", "Vegetable stock", "3 cups", "1 × 32 oz carton", "Pantry", ["Smoky black bean soup"]),
    // Separate line: cups of corn do not convert to the bag the Pantry holds.
    line("l23", "Corn kernels", "1 cup", "1 cup", "Frozen", ["Chicken burrito bowl"], { unconvertible: true }),
    line("l24", "Butter", "", "1 lb", "Dairy and eggs", [], { staple: true }),
    line("l25", "Bread", "", "1 loaf", "Bakery", [], { staple: true }),
    line("l26", "Dish soap", "", "1", "Other", [], { manual: true }),
    line("l27", "Coffee beans", "", "1 bag", "Other", [], { manual: true })
  ];

  const sections = ["Produce", "Meat and fish", "Dairy and eggs", "Bakery", "Pantry", "Frozen", "Other"];

  const log = {
    targets: { calories: 2200, protein: 140, carbs: 220, fat: 75 },
    entries: [
      { id: "e1", time: "7:40 AM", text: "Overnight oats with berries", kcal: 420, protein: 14, carbs: 62, fat: 12, status: "estimated" },
      { id: "e2", time: "12:35 PM", text: "Chicken burrito bowl, one portion", kcal: 640, protein: 48, carbs: 70, fat: 16, status: "estimated" },
      { id: "e3", time: "3:10 PM", text: "Apple and two spoons of peanut butter", kcal: 280, protein: 7, carbs: 30, fat: 16, status: "corrected" },
      { id: "e4", time: "4:05 PM", text: "Flat white", kcal: null, protein: null, carbs: null, fat: null, status: "estimating" }
    ]
  };

  const receiptText = `TRADER JOE'S #551
ORG BANANAS          1.29
SPINACH BABY 10OZ    2.99
CREMINI MUSH 1LB     2.49
CREMINI MUSH 1LB     2.49
GREEK YOG PLAIN 32   5.49
CHKPEAS 15OZ  2 @ 0.99
COCONUT MILK LITE    1.79
DISH SOAP LAV        2.99
SUBTOTAL            22.50`;

  const receiptItems = [
    { id: "ri1", name: "Bananas", qty: "1", unit: "bunch", include: true },
    { id: "ri2", name: "Baby spinach", qty: "10", unit: "oz", include: true },
    { id: "ri3", name: "Cremini mushrooms", qty: "2", unit: "lb", include: true },
    { id: "ri4", name: "Greek yoghurt", qty: "32", unit: "oz", include: true },
    { id: "ri5", name: "Chickpeas", qty: "2", unit: "can", include: true },
    { id: "ri6", name: "Coconut milk", qty: "1", unit: "can", include: true },
    { id: "ri7", name: "Dish soap", qty: "1", unit: "", include: false }
  ];

  const favourites = {
    "m-ben": ["r-tacos", "r-pancakes"],
    "m-maya": ["r-traybake", "r-farro"]
  };

  const lastWeek = ["Chicken burrito bowl", "Mushroom stroganoff", "Sheet-pan gnocchi", "Turkey chilli"];

  // AI tasks Meals names, with the model each currently resolves to.
  const models = [
    { task: "Plan writing and regeneration", tier: "Reasoning", model: "Claude Sonnet", bound: true },
    { task: "Quick swaps and chat requests", tier: "Interactive", model: "Instance default", bound: false },
    { task: "Nutrition estimates", tier: "Economy", model: "Instance default", bound: false },
    { task: "Receipt and fridge photos", tier: "Vision", model: "Instance default", bound: false }
  ];

  // Phase 3 to 5 records. Each screen marks these "Later".
  const later = {
    expiry: { pi3: "Nov 18", pi4: "Nov 7", pi9: "Nov 9", pi10: "Nov 5", pi12: "Nov 12", pi16: "Nov 6" },
    storage: {
      pi1: "Cupboard", pi2: "Cupboard", pi3: "Fridge", pi4: "Fridge", pi5: "Cupboard", pi6: "Cupboard",
      pi7: "Counter", pi8: "Counter", pi9: "Fridge", pi10: "Fridge", pi11: "Cupboard", pi12: "Fridge",
      pi13: "Cupboard", pi14: "Freezer", pi15: "Cupboard", pi16: "Fridge"
    },
    history: [
      { when: "Today, 9:12 AM", what: "Mark cooked: Overnight oats", change: "Milk −2/3 cup, Rolled oats −1/2 cup" },
      { when: "Yesterday, 7:48 PM", what: "Mark cooked: Black bean tacos", change: "Black beans −2 cans, Sour cream −1/2 cup" },
      { when: "Sunday, 11:02 AM", what: "Receipt from Trader Joe's", change: "7 items added" },
      { when: "Sunday, 10:40 AM", what: "Shopping list bought", change: "18 items added" }
    ],
    restock: [
      { name: "Coffee beans", every: "Every 2 weeks" },
      { name: "Greek yoghurt", every: "Weekly" }
    ],
    learned: {
      "m-ben": [
        "Rates Mexican dinners highly (4.6 stars over 9 meals).",
        "Skips breakfasts that take more than 10 minutes on weekdays.",
        "Rated two fish curries 2 stars. Moss now avoids coconut fish curries."
      ],
      "m-maya": [
        "Prefers mushroom dishes. Rated 5 stars four times.",
        "Rates spicy dinners lower than average.",
        "Leaves post-gym snacks under 350 kcal."
      ]
    },
    budget: { weekly: 140, estimate: 126 },
    kitchen: { owner: "Ben", members: ["Ben", "Maya"], invitePending: "maya@example.com" }
  };

  const data = {
    TODAY,
    members,
    slotRules,
    recipes,
    plan,
    swapPool,
    pantry,
    staples,
    list,
    sections,
    log,
    receiptText,
    receiptItems,
    favourites,
    lastWeek,
    models,
    later
  };

  // The "long text" review state stretches every name, line and note and inflates the numbers,
  // so wrapping and truncation show on every screen. It applies at load, so switching it reloads.
  const LONG_NAMES = { "m-ben": "Benedict Alexander", "m-maya": "Maya-Josephine Okonkwo-Whitfield" };
  const TAILS = [
    " with charred spring onions, smoked chilli butter and toasted seeds",
    " with slow-roasted garlic, preserved lemon and a crisp herb crumb",
    " with a sticky tamarind glaze, pickled shallots and coriander-free salsa verde"
  ];
  const tail = (i) => TAILS[i % TAILS.length];
  const big = (n) => (n == null ? n : Math.round(n * 7));

  const longify = (d) => {
    for (const m of d.members) {
      m.name = LONG_NAMES[m.id] || m.name;
      m.restrictions.push("Anything cooked in sesame oil or finished with tahini");
      m.preferences.push("Slow-cooked Sunday roasts with all the trimmings and extra gravy");
      m.target = big(m.target);
      if (m.linkedAccount) m.linkedAccount = "maya-josephine.okonkwo-whitfield@university-hospital.example.org";
    }
    Object.values(d.recipes).forEach((r, i) => {
      r.title += i === 9 ? " (high-protein-post-workout-Mediterranean-inspired)" : tail(i);
      r.minutes = r.minutes * 6 + 5;
      r.kcal = big(r.kcal);
      r.baseServings = r.baseServings * 6;
      for (const g of r.ingredients) {
        g.text += ", finely chopped and kept in a small bowl until the very end";
        g.name = `${g.name} from the farmers' market stall by the station`;
      }
      r.steps = r.steps.map(
        (s) =>
          `${s} Keep the heat at medium, stir now and then, and taste for salt before moving on, because the stock and the cheese both bring their own.`
      );
    });
    for (const day of d.plan.days)
      for (const meal of day.meals) {
        for (const f of meal.fit) {
          f.kcal = big(f.kcal);
          f.share = big(f.share);
        }
        if (meal.kind === "text")
          meal.text = `${meal.text} at Maya's sister's birthday dinner at the new Ethiopian place on Fifth Avenue`;
      }
    d.plan.request =
      "Meal prep breakfasts and weekday lunches that keep for four days in the fridge. Bring back Maya's traybake, keep Thursday under thirty minutes because of late meetings, and nothing with coriander, ever, for anyone in the house.";
    d.plan.writtenBy = "Claude Sonnet, extended reasoning, household model";
    d.pantry.forEach((p, i) => {
      p.name += i % 2 ? " (opened, kept in the door of the big fridge)" : " from the bulk shop on Caledonia Road";
      if (p.qty != null) p.qty = big(p.qty) * 13;
      p.updated = "a little over three weeks ago";
    });
    for (const s of d.staples) s.name += " (the good organic one from the market)";
    d.list.forEach((l, i) => {
      l.name += i % 3 ? " (organic, unwaxed, from the farmers' market)" : " (extra-large family-size value pack)";
      if (l.need) l.need = `${l.need} plus 2 lb 12 oz for the second batch`;
      l.buy = `${l.buy} plus 3 × 1 lb 10 oz bulk packs`;
      l.sources = l.sources.map((s, j) => s + tail(i + j));
    });
    d.log.targets = { calories: 14800, protein: 1240, carbs: 1980, fat: 625 };
    for (const e of d.log.entries) {
      e.text += ", plus a second helping and the leftover rice from the night before, eaten standing at the counter";
      for (const k of ["kcal", "protein", "carbs", "fat"]) e[k] = big(e[k]);
    }
    for (const r of d.receiptItems) r.name += " (organic, store own-brand, family-size value pack)";
    d.lastWeek = d.lastWeek.map((t, i) => t + tail(i));
    for (const m of d.models) m.task += " for the whole household, including shared Kitchens";
    for (const id of Object.keys(d.later.learned))
      d.later.learned[id] = d.later.learned[id].map(
        (s) => `${s} This held across the last six weeks of ratings, cooked marks and skipped meals.`
      );
    for (const h of d.later.history) h.change += ", Smoked paprika −1 tsp, Vegetable stock −3 cups, Garlic −3 cloves";
    for (const r of d.later.restock) r.name += " (the big bag from the roaster on the corner)";
    d.later.budget = { weekly: 12400, estimate: 11850 };
    d.later.kitchen = {
      owner: LONG_NAMES["m-ben"],
      members: Object.values(LONG_NAMES),
      invitePending: "maya-josephine.okonkwo-whitfield@university-hospital.example.org"
    };
  };

  if (/[?&]state=long(&|$)/.test(window.location.hash)) longify(data);

  window.MEALS_FAKE = data;
})();
