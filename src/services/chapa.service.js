'use strict';

const env = require('../config/env');
const AppError = require('../errors/AppError');

/**
 * Service to interface with Chapa payment gateway (API v1).
 */
class ChapaService {
  /**
   * Initializes a Chapa transaction for subscription payment.
   *
   * @param {object} params
   * @param {number} params.amount - Transaction amount (e.g. 1000)
   * @param {string} params.currency - Currency code (default: 'ETB')
   * @param {string} params.email - Customer email
   * @param {string} params.firstName - Customer first name / company
   * @param {string} params.lastName - Customer last name / role
   * @param {string} params.txRef - Unique reference for transaction
   * @param {string} [params.callbackUrl] - Webhook URL
   * @param {string} [params.returnUrl] - Redirect URL after payment completion
   * @returns {Promise<{ checkoutUrl: string, txRef: string }>}
   */
  async initializePayment({
    amount,
    currency = 'ETB',
    email,
    firstName = 'Customer',
    lastName = 'User',
    txRef,
    callbackUrl,
    returnUrl,
  }) {
    try {
      const payload = {
        amount: String(amount),
        currency,
        email,
        first_name: firstName,
        last_name: lastName,
        tx_ref: txRef,
        callback_url: callbackUrl,
        return_url: returnUrl,
        'customization[title]': 'KeferaJobs Subscription',
        'customization[description]': 'Payment for business account subscription plan',
      };

      const response = await fetch(`${env.chapa.baseUrl}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.chapa.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok || data.status !== 'success') {
        // If Chapa returns error or key is placeholder, return simulated sandbox URL
        if (env.chapa.secretKey.includes('placeholder')) {
          return {
            checkoutUrl: returnUrl || 'http://localhost:3000/api/v1/payments/simulated-success?tx_ref=' + txRef,
            txRef,
            isSimulated: true,
          };
        }
        throw new AppError(this._extractChapaMessage(data), 400);
      }

      return {
        checkoutUrl: data.data.checkout_url,
        txRef,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Graceful fallback for local development if Chapa network call fails or key is test placeholder
      if (env.chapa.secretKey.includes('placeholder')) {
        return {
          checkoutUrl: returnUrl || 'http://localhost:3000/api/v1/payments/simulated-success?tx_ref=' + txRef,
          txRef,
          isSimulated: true,
        };
      }
      throw new AppError(`Chapa service error: ${err.message}`, 502);
    }
  }

  /**
   * Chapa's error `message` field is inconsistent in shape: sometimes a
   * plain string ("Invalid API Key"), sometimes a Laravel-style
   * validation object keyed by field name to an array of strings
   * (`{ email: ["email has already been taken"] }`). Passing the raw
   * object straight into `new AppError(...)` silently stringified it to
   * the literal text "[object Object]" via JS's default Error message
   * coercion — that's what seekers were seeing on Boost failures. This
   * normalizes every shape down to one readable string.
   */
  _extractChapaMessage(data) {
    const fallback = 'Chapa payment initialization failed';
    const raw = data?.message;

    if (!raw) return fallback;
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.join(', ') || fallback;

    if (typeof raw === 'object') {
      const parts = Object.values(raw)
        .flat()
        .filter((v) => typeof v === 'string');
      if (parts.length) return parts.join(', ');
    }

    return fallback;
  }

  /**
   * Initiates a refund for a previously-verified transaction, per
   * Chapa's refund API (https://developer.chapa.co/refund):
   * `POST /v1/refund/<tx_ref>`. Chapa processes refunds
   * asynchronously — a `success` response here means the refund was
   * *accepted*, not that money has landed back with the payer yet
   * (their docs note the status settles to `refunded`/`reversed` some
   * time later, checkable via `GET /v1/refund/:ref_id/verify`). Callers
   * (admin.service.js) treat this accepted/initiated state as "refund
   * issued" for the purposes of the payment record and the SMS sent to
   * the company, same as this service's `initializePayment` already
   * treats "Chapa accepted the checkout" as success rather than
   * "the person finished paying."
   *
   * @param {object} params
   * @param {string} params.txRef - the original transaction's tx_ref
   * @param {number} [params.amount] - partial refund amount; omit for a full refund
   * @param {string} [params.reason] - shown on Chapa's dashboard for this refund
   * @returns {Promise<{ refundId: string|null, isSimulated?: boolean }>}
   */
  async refundPayment({ txRef, amount, reason }) {
    if (!txRef) {
      throw new AppError('refundPayment requires a txRef', 422);
    }

    // Same sandbox fallback as initializePayment/verifyPayment: without
    // a real secret key there's no Chapa account to actually call, so
    // local/demo environments simulate an accepted refund instead of
    // failing every rejection flow outright.
    if (this._isPlaceholderKey()) {
      return { refundId: `SIMULATED-REFUND-${txRef}`, isSimulated: true };
    }

    try {
      const payload = {
        ...(amount != null ? { amount: String(amount) } : {}),
        ...(reason ? { reason } : {}),
      };

      const response = await fetch(`${env.chapa.baseUrl}/refund/${encodeURIComponent(txRef)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.chapa.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok || data.status !== 'success') {
        throw new AppError(this._extractChapaMessage(data), 502);
      }

      return { refundId: data.data?.ref_id || null };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(`Chapa refund failed: ${err.message}`, 502);
    }
  }

  /** Shared by initializePayment/refundPayment's sandbox fallback. */
  _isPlaceholderKey() {
    return env.chapa.secretKey.includes('placeholder');
  }

  /**
   * Verifies a Chapa transaction status by reference.
   *
   * @param {string} txRef
   * @returns {Promise<boolean>}
   */
  async verifyPayment(txRef) {
    if (env.chapa.secretKey.includes('placeholder')) {
      // In placeholder test mode, automatically consider simulated payments valid
      return true;
    }

    try {
      const response = await fetch(`${env.chapa.baseUrl}/transaction/verify/${txRef}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${env.chapa.secretKey}`,
        },
      });

      const data = await response.json();
      return response.ok && data.status === 'success';
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chapa.service] Payment verification failed', err);
      return false;
    }
  }
}

module.exports = new ChapaService();
