/**
 * BijliSeva Mock Bill Payment Portal Interactive Logic
 */

window.checkBill = function () {
  const consumerInput = document.getElementById("consumer-num");
  const consumerVal = consumerInput ? consumerInput.value.trim() : "";

  if (!consumerVal) {
    alert("Please enter a Consumer Number (e.g. 100234567)");
    return;
  }

  const summarySection = document.getElementById("section-bill-summary");
  const summaryConsumerNo = document.getElementById("summary-consumer-no");

  if (summaryConsumerNo) {
    summaryConsumerNo.textContent = consumerVal;
  }

  if (summarySection) {
    summarySection.classList.remove("hidden");
    summarySection.scrollIntoView({ behavior: "smooth" });
  }
};

window.proceedToPayment = function () {
  const paymentSection = document.getElementById("section-payment");
  if (paymentSection) {
    paymentSection.classList.remove("hidden");
    paymentSection.scrollIntoView({ behavior: "smooth" });
  }
};

window.submitPayment = function () {
  const paymentSection = document.getElementById("section-payment");
  const summarySection = document.getElementById("section-bill-summary");
  const lookupSection = document.getElementById("section-lookup");
  const receiptSection = document.getElementById("section-receipt");
  const receiptTime = document.getElementById("receipt-time");

  if (receiptTime) {
    receiptTime.textContent = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }

  if (paymentSection) paymentSection.classList.add("hidden");
  if (summarySection) summarySection.classList.add("hidden");
  if (lookupSection) lookupSection.classList.add("hidden");

  if (receiptSection) {
    receiptSection.classList.remove("hidden");
    receiptSection.scrollIntoView({ behavior: "smooth" });
  }
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
    lookupSection.scrollIntoView({ behavior: "smooth" });
  }
};
