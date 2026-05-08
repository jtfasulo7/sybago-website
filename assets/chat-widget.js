(function () {
  if (window.__sybWidgetInit) return;
  window.__sybWidgetInit = true;

  const TEMPLATE = `
    <button class="syb-bubble" type="button" aria-label="Talk to JT" id="syb-bubble-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </button>
    <div class="syb-panel" role="dialog" aria-modal="false" aria-labelledby="syb-title">
      <div class="syb-head">
        <div>
          <h3 id="syb-title">Talk to JT</h3>
          <p>Drop your details and I'll text you back shortly.</p>
        </div>
        <button class="syb-close" type="button" aria-label="Close" id="syb-close-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="syb-body" id="syb-body">
        <form id="syb-form" novalidate>
          <div class="syb-row">
            <div class="syb-field">
              <label for="syb-first">First name</label>
              <input type="text" id="syb-first" name="firstName" required autocomplete="given-name" maxlength="80">
            </div>
            <div class="syb-field">
              <label for="syb-last">Last name</label>
              <input type="text" id="syb-last" name="lastName" required autocomplete="family-name" maxlength="80">
            </div>
          </div>
          <div class="syb-field">
            <label for="syb-phone">Phone</label>
            <input type="tel" id="syb-phone" name="phone" required autocomplete="tel" maxlength="32" placeholder="(555) 555-5555">
          </div>
          <div class="syb-field">
            <label for="syb-message">Message</label>
            <textarea id="syb-message" name="message" required maxlength="2000" placeholder="What can we help with?"></textarea>
          </div>
          <div class="syb-honeypot" aria-hidden="true">
            <label for="syb-company-website">Don't fill this out if you're human</label>
            <input type="text" id="syb-company-website" name="company_website" tabindex="-1" autocomplete="off">
          </div>
          <button class="syb-submit" type="submit" id="syb-submit-btn">Send</button>
          <div class="syb-status" id="syb-status" role="alert"></div>
        </form>
      </div>
    </div>
  `;

  function build() {
    const root = document.createElement('div');
    root.id = 'syb-widget';
    root.innerHTML = TEMPLATE;
    document.body.appendChild(root);
    wire(root);
  }

  function wire(root) {
    const bubble = root.querySelector('#syb-bubble-btn');
    const closeBtn = root.querySelector('#syb-close-btn');
    const form = root.querySelector('#syb-form');
    const submitBtn = root.querySelector('#syb-submit-btn');
    const status = root.querySelector('#syb-status');
    const body = root.querySelector('#syb-body');

    function open() {
      root.classList.add('open');
      setTimeout(() => root.querySelector('#syb-first')?.focus(), 250);
    }
    function close() { root.classList.remove('open'); }
    function toggle() { root.classList.contains('open') ? close() : open(); }

    bubble.addEventListener('click', toggle);
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && root.classList.contains('open')) close();
    });

    function showStatus(type, message) {
      status.className = 'syb-status ' + type;
      status.textContent = message;
    }
    function clearStatus() {
      status.className = 'syb-status';
      status.textContent = '';
    }

    function normalizeUSPhone(input) {
      const digits = String(input).replace(/\D/g, '');
      let core = digits;
      if (core.length === 11 && core[0] === '1') core = core.slice(1);
      if (core.length !== 10) return null;
      if (core[0] === '0' || core[0] === '1') return null;
      return '+1' + core;
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearStatus();

      if (form.company_website.value) return;

      const data = {
        firstName: form.firstName.value.trim(),
        lastName: form.lastName.value.trim(),
        phone: form.phone.value.trim(),
        message: form.message.value.trim(),
        source: 'sybago.ai' + (location.pathname || '/'),
        company_website: '',
      };

      if (!data.firstName) return showStatus('error', 'Please enter your first name.');
      if (!data.lastName) return showStatus('error', 'Please enter your last name.');
      if (!data.phone) return showStatus('error', 'Please enter your phone number.');
      if (!normalizeUSPhone(data.phone)) {
        return showStatus('error', 'Please enter a valid US phone number.');
      }
      if (!data.message) return showStatus('error', 'Please add a short message.');

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';

      try {
        const resp = await fetch('/api/lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!resp.ok) throw new Error('upstream');

        body.innerHTML = `
          <div class="syb-success-card">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <h4>Thanks &mdash; message received.</h4>
            <p>JT will text you back shortly.</p>
          </div>
        `;
      } catch (err) {
        showStatus('error', 'Something went wrong, please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
