// "Imprimer" button of the statement ticket. The button is created here, never in the HTML of the server: with no JavaScript
// (or with the script blocked) there is no button that does nothing. It goes next to the other actions of the ticket.
const actions = document.querySelector(".actions");
if (actions) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "imprimer";
  button.textContent = "Imprimer";
  button.addEventListener("click", () => window.print());
  actions.prepend(button);
}
