# Meals package

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
