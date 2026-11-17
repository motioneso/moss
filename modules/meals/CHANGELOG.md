# Meals package

## 0.1.0

- Meals starts as a package that keeps the same 20 tables and saved data as before.
- The kitchen, the household and four chat tools work: read the kitchen, change kitchen settings, add or change a household member, and remove one.
- Changes through chat need the host's one-use approval. Reading a brand new kitchen saves nothing.
- Meal plans work through chat: start, read, stop, resume, retry a day and regenerate. A background job writes each day and checks every meal against each eater's never-serve list and calorie target. Calories per serving stay empty for now.
- Recipes beyond plans, shopping lists, the pantry maths, the food log and screens are not part of this package yet.
