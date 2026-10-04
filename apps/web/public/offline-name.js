// Shows the saved assistant name in the offline page's tab title.
// Loaded as an external file because the deployed content security policy blocks inline scripts.
(function () {
  try {
    var name = (localStorage.getItem("moss.assistantName") || "").trim();
    if (name) document.title = name + " Offline";
  } catch (e) {
    return;
  }
})();
