# Web Research package

## 0.1.0

- Web Research starts as a built-in package. Chat and other modules can search the web, and it says whether search is on and why not.
- Search uses the saved Brave Search key first. Without one it follows the built-in model search switch and then the person's chat model.
- A search the chat model could answer on its own returns no results for now, because this server cannot yet read the pages the model cited.
- The screen to save the search key and the switch to turn built-in search off are not part of this package yet.
- Chat and other modules can now read public web pages. Up to five pages are read at once. Each comes back with its title, up to 12,000 characters of text and a short excerpt. Only HTTPS pages on public addresses are read, a site's robots rules are followed, and one site is called at most once a second. A page that cannot be read is skipped with a reason and the others still return.
- Pages must be web pages or plain text. Files such as images and downloads are skipped.
- Web Research has a read route for the signed-in person that does the same as the chat tool.
