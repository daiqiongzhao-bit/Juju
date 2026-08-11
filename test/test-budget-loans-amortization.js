/**
 * Test: Darlehens-Amortisation (#569)
 * Zweck: Kern-Mathematik des Annuitätendarlehens - konstante Monatsrate aus
 *        Sollzins + Anfangstilgung, korrekter Phasenwechsel nach der Zinsbindung
 *        auf den Prognose-Anschlusszins, Restschuld, Laufzeit-Ableitung und die
 *        Schutzfälle (Rate deckt Zins nicht / Laufzeit zu lang). Rein, ohne DB.
 * Ausführen: node --test test/test-budget-loans-amortization.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLoanSchedule, remainingPrincipalAfter, MAX_LOAN_MONTHS } from '../server/services/loan-amortization.js';

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

test('konstante Monatsrate = Kreditsumme × (Sollzins + Anfangstilgung) / 12', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(r.ok, true);
  assert.ok(near(r.monthlyPayment, 750), `monthlyPayment ${r.monthlyPayment}`);
  // Erste Rate: Zinsanteil 200000 × 2,5%/12 = 416,67, Tilgung = 333,33.
  assert.ok(near(r.schedule[0].interest, 416.67), `interest[0] ${r.schedule[0].interest}`);
  assert.ok(near(r.schedule[0].principal, 333.33), `principal[0] ${r.schedule[0].principal}`);
});

test('Plan tilgt vollständig: Restschuld endet bei 0, Summen stimmen', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(r.ok, true);
  assert.equal(r.schedule.at(-1).balance, 0);
  assert.equal(r.totalMonths, r.schedule.length);
  assert.ok(r.totalMonths > 0 && r.totalMonths <= MAX_LOAN_MONTHS);
  const sumPrincipal = r.schedule.reduce((s, x) => s + x.principal, 0);
  assert.ok(near(sumPrincipal, 200000, 0.5), `Σprincipal ${sumPrincipal}`);
  assert.ok(near(r.totalRepayment, 200000 + r.totalInterest, 0.02));
  assert.ok(r.schedule.every((x) => x.rate === 2.5 && x.phase === 1));
});

test('fixed_then_variable: Phasenwechsel nach der Zinsbindung', () => {
  const r = computeLoanSchedule({
    principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2,
    interestMode: 'fixed_then_variable', fixedPeriodMonths: 180, followupRate: 4,
  });
  assert.equal(r.ok, true);
  assert.ok(near(r.monthlyPayment, 750));
  const m180 = r.schedule.find((x) => x.n === 180);
  const m181 = r.schedule.find((x) => x.n === 181);
  assert.equal(m180.rate, 2.5);
  assert.equal(m180.phase, 1);
  assert.equal(m181.rate, 4);
  assert.equal(m181.phase, 2);
  assert.ok(r.remainingAfterBinding > 0 && r.remainingAfterBinding < 200000, `Restschuld ${r.remainingAfterBinding}`);
  assert.ok(near(r.remainingAfterBinding, m180.balance, 0.02));
});

test('höherer Anschlusszins verlängert die Laufzeit ggü. durchgängigem Festzins', () => {
  const base = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  const variable = computeLoanSchedule({
    principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2,
    interestMode: 'fixed_then_variable', fixedPeriodMonths: 180, followupRate: 4,
  });
  assert.equal(base.ok, true);
  assert.equal(variable.ok, true);
  assert.ok(variable.totalMonths > base.totalMonths, `variable ${variable.totalMonths} vs fixed ${base.totalMonths}`);
});

test("Modus 'fixed' ignoriert Zinsbindung/Anschlusszins (durchgängig Sollzins)", () => {
  const r = computeLoanSchedule({
    principal: 100000, fixedRate: 3, initialRepaymentRate: 2,
    interestMode: 'fixed', fixedPeriodMonths: 60, followupRate: 9,
  });
  assert.equal(r.ok, true);
  assert.ok(r.schedule.every((x) => x.rate === 3 && x.phase === 1));
  assert.equal(r.remainingAfterBinding, 0);
});

test("Modus 'variable' rechnet einphasig wie 'fixed' (keine Zinsbindung)", () => {
  const variable = computeLoanSchedule({
    principal: 150000, fixedRate: 3.5, initialRepaymentRate: 2, interestMode: 'variable',
  });
  const fixed = computeLoanSchedule({
    principal: 150000, fixedRate: 3.5, initialRepaymentRate: 2, interestMode: 'fixed',
  });
  assert.equal(variable.ok, true);
  assert.equal(variable.monthlyPayment, fixed.monthlyPayment);
  assert.equal(variable.totalMonths, fixed.totalMonths);
  assert.equal(variable.totalInterest, fixed.totalInterest);
  assert.ok(variable.schedule.every((x) => x.rate === 3.5 && x.phase === 1));
  assert.equal(variable.remainingAfterBinding, 0, 'ohne Bindung gibt es keine Restschuld-Marke');
});

test("Modus 'variable' ignoriert mitgeschickte Bindungsfelder", () => {
  const r = computeLoanSchedule({
    principal: 150000, fixedRate: 3.5, initialRepaymentRate: 2,
    interestMode: 'variable', fixedPeriodMonths: 120, followupRate: 9,
  });
  assert.equal(r.ok, true);
  assert.ok(r.schedule.every((x) => x.rate === 3.5 && x.phase === 1));
  assert.equal(r.remainingAfterBinding, 0);
});

test('Schutz: Anschlusszins zu hoch → tilgt nicht (not_amortizing)', () => {
  const r = computeLoanSchedule({
    principal: 100000, fixedRate: 1, initialRepaymentRate: 1,
    interestMode: 'fixed_then_variable', fixedPeriodMonths: 12, followupRate: 20,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_amortizing');
});

test('Schutz: unrealistisch lange Laufzeit wird abgewiesen (ok:false)', () => {
  const r = computeLoanSchedule({ principal: 100000, fixedRate: 8, initialRepaymentRate: 0.05, interestMode: 'fixed' });
  assert.equal(r.ok, false);
});

test('niedrigere Anfangstilgung → längere Laufzeit', () => {
  const low = computeLoanSchedule({ principal: 100000, fixedRate: 3, initialRepaymentRate: 1, interestMode: 'fixed' });
  const high = computeLoanSchedule({ principal: 100000, fixedRate: 3, initialRepaymentRate: 4, interestMode: 'fixed' });
  assert.equal(low.ok, true);
  assert.equal(high.ok, true);
  assert.ok(low.totalMonths > high.totalMonths);
});

// --------------------------------------------------------------------------
// Restschuld zum Ratenstand
// --------------------------------------------------------------------------

test('remainingPrincipalAfter: 0 Raten = Kreditsumme, n Raten = Plan-Restschuld', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(r.ok, true);
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, 0), 200000, 'vor der ersten Rate ist nichts getilgt');
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, 1), r.schedule[0].balance);
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, 60), r.schedule[59].balance);
  assert.ok(remainingPrincipalAfter(r.schedule, 200000, 60) < 200000, 'die Restschuld sinkt');
});

test('remainingPrincipalAfter: getilgt bleibt 0, auch über den Plan hinaus', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, r.totalMonths), 0);
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, r.totalMonths + 50), 0, 'kein negatives Kapital');
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, -5), 200000, 'unsinnige Eingabe fällt auf die Kreditsumme zurück');
});

// Auslöser: Die Karte zeigte die Summe der Restraten und wurde als Restschuld
// gelesen. Beide Größen dürfen bei verzinsten Darlehen nie gleichgesetzt werden -
// die Differenz sind exakt die Zinsen, die in den Restraten noch stecken.
test('Restschuld liegt unter der Summe der Restraten, Differenz = Restzinsen', () => {
  // Nachgebauter Nutzerfall: 21.000 € zu 4,07 %, 72 Raten à 330,10 €, 44 gezahlt.
  const r = computeLoanSchedule({
    principal: 21000, fixedRate: 4.07, initialRepaymentRate: 14.792857, interestMode: 'fixed',
  });
  assert.equal(r.ok, true);
  assert.ok(near(r.monthlyPayment, 330.10), `monthlyPayment ${r.monthlyPayment}`);
  assert.equal(r.totalMonths, 72);

  const paid = 44;
  const principalLeft = remainingPrincipalAfter(r.schedule, 21000, paid);
  const rest = r.schedule.slice(paid);
  const paymentsLeft = rest.reduce((s, x) => s + x.interest + x.principal, 0);
  const interestLeft = rest.reduce((s, x) => s + x.interest, 0);

  assert.ok(principalLeft < paymentsLeft, `Restschuld ${principalLeft} muss unter ${paymentsLeft} liegen`);
  assert.ok(near(paymentsLeft - principalLeft, interestLeft, 0.5), 'die Differenz sind die Restzinsen');
  // Summe der planmäßigen Tilgungsanteile ab hier == Restschuld.
  assert.ok(near(rest.reduce((s, x) => s + x.principal, 0), principalLeft, 0.5));
});
