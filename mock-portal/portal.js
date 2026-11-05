/**
 * BijliSeva demo portal interactions.
 * All values are fictional and no real payment is processed.
 */

const get = (id) => document.getElementById(id);
const hide = (id) => get(id)?.classList.add("hidden");
const show = (id) => get(id)?.classList.remove("hidden");

function updateSteps(activeStep) {
  document.querySelectorAll(".step").forEach((step, index) => {
    step.classList.toggle("active", index === activeStep - 1);
    step.classList.toggle("complete", index < activeStep - 1);
  });
}

function scrollToSection(id) {
  get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

window.showToast = function (message) {
  const toast = get("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
};

window.checkBill = function () {
  const consumerInput = get("consumer-num");
  const consumerVal = consumerInput?.value.trim() || "";
  if (!consumerVal) {
    window.showToast("Please enter a Consumer Number, for example 100234567.");
    consumerInput?.focus();
    return;
  }

  get("summary-consumer-no").textContent = consumerVal;
  if (get("receipt-consumer")) get("receipt-consumer").textContent = consumerVal;
  show("section-bill-summary");
  hide("section-payment");
  hide("section-receipt");
  updateSteps(2);
  window.showToast("Bill found. Please review the details before payment.");
  scrollToSection("section-bill-summary");
};

window.proceedToPayment = function () {
  show("section-payment");
  updateSteps(3);
  scrollToSection("section-payment");
};

window.backToBill = function () {
  hide("section-payment");
  updateSteps(2);
  scrollToSection("section-bill-summary");
};

window.submitPayment = function () {
  hide("section-payment");
  hide("section-bill-summary");
  hide("section-lookup");
  const consumerValue = get("consumer-num")?.value.trim() || "100234567";
  const transactionId = `TXN-${Math.floor(1000000000 + Math.random() * 8999999999)}`;
  if (get("receipt-consumer")) get("receipt-consumer").textContent = consumerValue;
  if (get("receipt-txnid")) get("receipt-txnid").textContent = transactionId;
  if (get("receipt-time")) get("receipt-time").textContent = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  show("section-receipt");
  updateSteps(3);
  window.showToast("Payment successful. Your demo receipt is ready.");
  scrollToSection("section-receipt");
};

window.resetPortal = function () {
  hide("section-payment");
  hide("section-bill-summary");
  hide("section-receipt");
  show("section-lookup");
  get("form-bill-lookup")?.reset();
  get("form-payment")?.reset();
  document.querySelectorAll(".method-card").forEach((card, index) => card.classList.toggle("selected", index === 0));
  updateSteps(1);
  scrollToSection("section-lookup");
};

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".method-card input[type='radio']").forEach((input) => {
    input.addEventListener("change", () => {
      document.querySelectorAll(".method-card").forEach((card) => card.classList.remove("selected"));
      input.closest(".method-card")?.classList.add("selected");
    });
  });

  get("consumer-num")?.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 12);
  });
});
