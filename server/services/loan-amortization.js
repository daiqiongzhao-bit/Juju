/**
 * Modul: Darlehens-Amortisation (Annuitätendarlehen nach deutschem Muster, #569)
 * Zweck: Aus Kreditsumme, Sollzins und Anfangstilgung die konstante Monatsrate und
 *        daraus den vollständigen Tilgungsplan (Zins-/Tilgungsanteil, Restschuld,
 *        Laufzeit) berechnen. Optional wechselt der Zins nach der Zinsbindung auf
 *        einen Prognose-Anschlusszins (fixed_then_variable).
 *
 * Modell (bewusst als Prognose):
 *   - Monatsrate A = Kreditsumme × (Sollzins% + Anfangstilgung%) / 100 / 12, konstant.
 *   - Je Monat: Zinsanteil = Restschuld × Monatszins; Tilgung = A − Zinsanteil.
 *   - Nach der Zinsbindung bleibt die Rate A gleich, es rechnet aber der
 *     Prognose-Anschlusszins weiter (mehr Zins-, weniger Tilgungsanteil → längere
 *     Restlaufzeit). Reale variable Zinsen schwanken monatlich; hier ein
 *     angenommener Wert, daher „Prognose".
 *   - interestMode 'variable' (Darlehen ganz ohne Zinsbindung) rechnet identisch
 *     zu 'fixed': ein Zinssatz über die ganze Laufzeit, keine Phasen. Der
 *     Unterschied ist die Zusage, nicht die Mathematik — der Satz ist der aktuelle
 *     und kann sich jederzeit ändern, die Laufzeit ist also nur eine Momentaufnahme.
 *   - Die Laufzeit ergibt sich aus der Tilgung (kein manuelles Ratenlimit).
 *
 * Rein synchron, ohne Seiteneffekte/DB — netzfrei testbar (test:budget-loans-amortization).
 */

// Sicherheitskappe: 50 Jahre. Verhindert Endlosschleifen bei Eingaben, deren Rate
// die Tilgung nie abschließt; solche Fälle werden als nicht tilgend gemeldet.
export const MAX_LOAN_MONTHS = 600;

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} params
 * @param {number} params.principal            Kreditsumme in Euro (> 0)
 * @param {number} params.fixedRate            Sollzins p.a. in % (>= 0), Phase 1
 *                                             (bei 'variable': aktueller variabler Zins)
 * @param {number} params.initialRepaymentRate Anfangstilgung p.a. in % (> 0)
 * @param {'fixed'|'variable'|'fixed_then_variable'} params.interestMode
 * @param {number|null} [params.fixedPeriodMonths] Zinsbindung in Monaten (nur fixed_then_variable)
 * @param {number|null} [params.followupRate]      Prognose-Anschlusszins p.a. in % (nur fixed_then_variable)
 * @returns {{ ok: true, monthlyPayment: number, totalMonths: number, totalInterest: number,
 *             totalRepayment: number, remainingAfterBinding: number,
 *             schedule: Array<{ n: number, rate: number, interest: number, principal: number, balance: number, phase: 1|2 }> }
 *           | { ok: false, reason: 'not_amortizing' | 'too_long' }}
 */
export function computeLoanSchedule({
  principal,
  fixedRate,
  initialRepaymentRate,
  interestMode,
  fixedPeriodMonths = null,
  followupRate = null,
}) {
  const P = Number(principal);
  const rf = Number(fixedRate);
  const rt = Number(initialRepaymentRate);
  // Nur 'fixed_then_variable' hat zwei Phasen. 'variable' ist einphasig wie
  // 'fixed' (ein Satz, keine Bindung) — daher hier bewusst kein Sonderfall.
  const variable = interestMode === 'fixed_then_variable';
  const rv = variable ? Number(followupRate) : rf;
  const bindingMonths = variable && Number.isFinite(Number(fixedPeriodMonths))
    ? Number(fixedPeriodMonths)
    : null;

  // Konstante Monatsrate (auf Cent gerundet, wie real belastet).
  const monthly = round2((P * (rf + rt)) / 100 / 12);

  let balance = P;
  let totalInterest = 0;
  let remainingAfterBinding = 0;
  const schedule = [];

  for (let n = 1; n <= MAX_LOAN_MONTHS && balance > 0.005; n++) {
    const inFixed = !bindingMonths || n <= bindingMonths;
    const rate = inFixed ? rf : rv;
    const interest = balance * (rate / 100 / 12);
    let principalPart = monthly - interest;
    // Rate deckt den Zins nicht → das Darlehen tilgt nicht (z. B. Anschlusszins zu hoch).
    if (principalPart <= 0) return { ok: false, reason: 'not_amortizing' };
    if (principalPart > balance) principalPart = balance; // letzte (Teil-)Rate

    balance -= principalPart;
    totalInterest += interest;
    schedule.push({
      n,
      rate,
      interest: round2(interest),
      principal: round2(principalPart),
      balance: round2(Math.max(0, balance)),
      phase: inFixed ? 1 : 2,
    });
    if (bindingMonths && n === bindingMonths) remainingAfterBinding = round2(Math.max(0, balance));
  }

  if (balance > 0.005) return { ok: false, reason: 'too_long' };

  return {
    ok: true,
    monthlyPayment: monthly,
    totalMonths: schedule.length,
    totalInterest: round2(totalInterest),
    totalRepayment: round2(P + totalInterest),
    remainingAfterBinding,
    schedule,
  };
}

/**
 * Planmäßige Restschuld (offenes Kapital) nach `paidInstallments` gezahlten Raten.
 *
 * Abgrenzung: Das ist NICHT die Summe der noch offenen Raten. Die enthält auch die
 * Zinsen der Restlaufzeit und liegt deshalb immer höher. Banken melden die
 * Restschuld, also den hier berechneten Wert - die Verwechslung war der Auslöser
 * dieser Funktion.
 *
 * Der Wert kommt aus dem Tilgungsplan, ist also planmäßig: er unterstellt, dass
 * jede Rate in Höhe der Annuität und zum Fälligkeitsmonat gezahlt wurde. Abweichend
 * gebuchte Ratenbeträge verschieben die reale Tilgung und werden hier bewusst nicht
 * nachgeführt, damit die Restschuld zur selben Prognose gehört wie Monatsrate,
 * Gesamtzins und Laufzeit.
 *
 * @param {Array<{ balance: number }>} schedule Tilgungsplan aus computeLoanSchedule
 * @param {number} principal        Kreditsumme (Restschuld vor der ersten Rate)
 * @param {number} paidInstallments Anzahl bereits gezahlter Raten (>= 0)
 * @returns {number} Restschuld in Euro, auf Cent gerundet
 */
export function remainingPrincipalAfter(schedule, principal, paidInstallments) {
  const paid = Math.floor(Number(paidInstallments) || 0);
  if (paid <= 0) return round2(Number(principal) || 0);
  // Über den Plan hinaus gebuchte Raten können das Kapital nicht unter null drücken.
  if (paid >= schedule.length) return 0;
  return schedule[paid - 1].balance;
}
