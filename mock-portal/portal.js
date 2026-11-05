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

  const summarySection = document.getElementById("section-bill-summary");
  const summaryConsumerNo = document.getElementById("summary-consumer-no");

  if (summaryConsumerNo) {
    summaryConsumerNo.textContent = consumerVal;
  }

  if (summarySection) {
    summarySection.classList.remove("hidden");
    setProgress(2);
    summarySection.scrollIntoView({ behavior: "smooth" });
  }
};

function setProgress(activeStep) {
  document.querySelectorAll(".payment-progress li").forEach((step, index) => {
    const number = index + 1;
    step.classList.toggle("current", number === activeStep);
    step.classList.toggle("complete", number < activeStep);
    if (number === activeStep) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

window.proceedToPayment = function () {
  const paymentSection = document.getElementById("section-payment");
  if (paymentSection) {
    paymentSection.classList.remove("hidden");
    setProgress(3);
    paymentSection.scrollIntoView({ behavior: "smooth" });
  }
};

function updatePaymentMethod() {
  const selected = document.querySelector('input[name="pay_mode"]:checked')?.value || "upi";
  for (const mode of ["upi", "card", "netbanking"]) {
    document.getElementById(`payment-fields-${mode}`)?.classList.toggle("hidden", selected !== mode);
  }
  document.querySelectorAll(".payment-option").forEach((option) => {
    const radio = option.querySelector('input[name="pay_mode"]');
    option.classList.toggle("selected", Boolean(radio?.checked));
  });
}

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
  const paymentSection = document.getElementById("section-payment");
  const summarySection = document.getElementById("section-bill-summary");
  const lookupSection = document.getElementById("section-lookup");
  const receiptSection = document.getElementById("section-receipt");

  if (paymentSection) paymentSection.classList.add("hidden");
  if (summarySection) summarySection.classList.add("hidden");
  if (receiptSection) receiptSection.classList.add("hidden");
  if (lookupSection) {
    lookupSection.classList.remove("hidden");
    setProgress(1);
    lookupSection.scrollIntoView({ behavior: "smooth" });
  }
};

document.getElementById("form-bill-lookup")?.addEventListener("submit", (event) => {
  event.preventDefault();
  window.checkBill();
});

document.getElementById("btn-proceed-pay")?.addEventListener("click", window.proceedToPayment);
document.querySelectorAll('input[name="pay_mode"]').forEach((radio) => radio.addEventListener("change", updatePaymentMethod));
updatePaymentMethod();
document.getElementById("form-payment")?.addEventListener("submit", (event) => {
  event.preventDefault();
  window.submitPayment();
});
document.getElementById("btn-return-home")?.addEventListener("click", window.resetPortal);
