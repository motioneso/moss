# Meals package

## 0.1.0

- Meals starts as a package that keeps the same 20 tables and saved data as before.
- The kitchen, the household and four chat tools work: read the kitchen, change kitchen settings, add or change a household member, and remove one.
- Changes through chat need the host's one-use approval. Reading a brand new kitchen saves nothing.
- Meal plans work through chat: start, read, stop, resume, retry a day and regenerate. A background job writes each day and checks every meal against each eater's never-serve list and calorie target. Calories per serving stay empty for now.
- Shopping lists work through chat: build from a plan, read, add, change, tick, untick, remove, mark as bought, and clear.
- The Pantry works through chat: read it, add, change and remove items, and add, rename and remove Staples. Changing the Pantry updates a list that follows a plan, and a finished plan day does the same.
- Removing a line or item and marking lines as bought each leave an undo record. Undoing is not part of this package yet.
- Clearing a list removes its lines and nothing else.
- Recipes beyond plans, the food log, the wider pantry maths and screens are not part of this package yet.
