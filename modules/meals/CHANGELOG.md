# Meals package

## 0.2.0

- Meals has a screen with three areas: the Plan, the Shopping list and the Pantry, plus a recipe page for each planned meal.
- The Plan shows tonight's dinner and each day as Moss writes it. Lock a meal, swap it for a quick option, regenerate a meal or a day, stop and resume, re-plan the rest of the week, or delete the plan.
- A recipe page shows ingredients and method, with servings, Mark cooked, ratings, favourites and Undo.
- The Shopping list groups lines by store section. Tick lines, add or edit them, mark them Bought to move them to the Pantry, build the list from the plan, or clear it. Undo works after a removal or a Bought.
- The Pantry lists what you have on hand with find, add, edit, remove and Staples.
- Changes made on the screen need no chat approval because you click them. Removing data asks you to confirm first.
- Household, Log and settings screens, and the swap, move, eaters and text helpers, are not on the screen yet.

## 0.1.0

- Meals starts as a package that keeps the same 20 tables and saved data as before.
- The kitchen, the household and four chat tools work: read the kitchen, change kitchen settings, add or change a household member, and remove one.
- Changes through chat need the host's one-use approval. Reading a brand new kitchen saves nothing.
- Meal plans work through chat: start, read, stop, resume, retry a day and regenerate. A background job writes each day and checks every meal against each eater's never-serve list and calorie target. Calories per serving stay empty for now.
- Shopping lists work through chat: build from a plan, read, add, change, tick, untick, remove, mark as bought, and clear.
- The Pantry works through chat: read it, add, change and remove items, and add, rename and remove Staples. Changing the Pantry updates a list that follows a plan, and a finished plan day does the same.
- Removing a line or item and marking lines as bought each leave an undo record. Undo restores the record kept before the write.
- Clearing a list removes its lines and nothing else.
- The food log works through chat: log a meal from a description, read a day or a range, add up a range, retry an estimate, correct a meal or one of its foods, and delete a meal. A new meal is saved at once as pending and a background job estimates its calories and macros. An estimate is always shown as an estimate, and anything it cannot tell stays unknown, never zero.
- Cooking and ratings work through chat: mark a planned meal cooked, which takes what the recipe used out of the Pantry without going below zero and offers to log the portion, and rate a meal's recipe from 1 to 5 stars for each person. Undo works for a removed line or Pantry item, a Bought, and a Mark cooked, and skips any Pantry amount edited since.
- Recipes beyond plans, the wider pantry maths and screens are not part of this package yet.
- The rest of the Meals chat tools work: read one meal as a recipe, change servings, lock, unlock, move or change who eats a meal, swap a meal for a checked choice or a quick one, arrange a day, edit favourites and place one in a meal, re-plan the rest of the week, and delete a plan. Swaps and Safety re-checks run as background jobs.
- The whole-account export and delete now cover every Meals table, and only the signed-in person's rows.
