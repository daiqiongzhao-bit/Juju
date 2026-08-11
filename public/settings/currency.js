import { getLocale } from '/i18n.js';

// Haushaltweite Währungsauswahl. Muss exakt mit VALID_CURRENCIES in
// server/routes/preferences.js übereinstimmen (per Test abgesichert).
export const SUPPORTED_CURRENCIES = [
  'AED', 'ARS', 'AUD', 'BBD', 'BOB', 'BRL', 'BSD', 'BZD', 'CAD', 'CHF', 'CLP',
  'CNY', 'COP', 'CRC', 'CUP', 'CZK', 'DKK', 'DOP', 'EUR', 'GBP', 'GTQ', 'GYD',
  'HNL', 'HTG', 'HUF', 'IDR', 'INR', 'IRR', 'JMD', 'JPY', 'KRW', 'KZT', 'MXN',
  'MYR', 'NIO', 'NOK', 'NZD', 'PAB', 'PEN', 'PHP', 'PLN', 'PYG', 'RUB', 'SAR',
  'SEK', 'SRD', 'TRY', 'TTD', 'UAH', 'USD', 'UYU', 'VES', 'XCD', 'ZAR',
];

export async function persistCurrencySelection(select, previousCurrency, save) {
  select.disabled = true;
  try {
    await save();
  } catch (error) {
    select.value = previousCurrency;
    throw error;
  } finally {
    select.disabled = false;
  }
}

export function appendCurrencyOptions(select, selectedCurrency) {
  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames([getLocale()], { type: 'currency' });
  } catch {
    // Currency codes remain usable when DisplayNames is unavailable.
  }

  for (const currency of SUPPORTED_CURRENCIES) {
    const option = document.createElement('option');
    option.value = currency;
    const displayName = displayNames?.of(currency);
    option.textContent = displayName ? `${currency} - ${displayName}` : currency;
    option.selected = currency === selectedCurrency;
    select.appendChild(option);
  }
}
