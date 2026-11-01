
/*
  LeadCRM Daily Focus
  Uses existing follow-up dates.
  No database changes or external API calls.
*/

(() => {
  const STORAGE_PREFIX = 'leadcrm-daily-focus-seen:';

  const STAGE_PRIORITY = {
    Negotiation: 6,
    Proposal: 5,
    Requirement: 4,
    Replied: 3,
    Contacted: 2,
    New: 1
  };

  const closedStages = new Set(['Won', 'Lost']);
  const ROOT_ID = 'dailyFocusOverlay';

  let overlay;
  let launcher;
  let lastTrigger = null;
  let visible = false;
  let autoShown = false;
  let currentFocusId = null;
  let latestFingerprint = '';

  function localDate() {
    const d = new Date();

    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ].join('-');
  }

  function wasSeen() {
    try {
      return localStorage.getItem(
        STORAGE_PREFIX + localDate()
      ) === '1';
    } catch {
      return autoShown;
    }
  }

  function markSeen() {
    autoShown = true;

    try {
      localStorage.setItem(
        STORAGE_PREFIX + localDate(),
        '1'
      );
    } catch {
      // Private browsing may restrict storage.
    }
  }

  function pending() {
    if (
      typeof leads === 'undefined' ||
      !Array.isArray(leads)
    ) {
      return [];
    }

    const today = localDate();

    return leads
      .filter(l =>
        l &&
        !closedStages.has(l.stage) &&
        typeof l.follow_up_date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(l.follow_up_date) &&
        l.follow_up_date <= today
      )
      .sort((a, b) => {
        const aOverdue =
          a.follow_up_date < today ? 1 : 0;

        const bOverdue =
          b.follow_up_date < today ? 1 : 0;

        if (aOverdue !== bOverdue) {
          return bOverdue - aOverdue;
        }

        const stageDifference =
          (STAGE_PRIORITY[b.stage] || 0) -
          (STAGE_PRIORITY[a.stage] || 0);

        if (stageDifference) {
          return stageDifference;
        }

        return a.follow_up_date.localeCompare(
          b.follow_up_date
        );
      });
  }

  function elt(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
      node.className = className;
    }

    if (text !== undefined) {
      node.textContent = String(text);
    }

    return node;
  }

  function mount() {
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    const cmdRight =
      document.querySelector('.v3-command-right');

    const main =
      document.querySelector('main.wrap');

    if (!main) {
      return;
    }

    launcher = elt('button', 'focus-launch');
    launcher.type = 'button';

    launcher.setAttribute(
      'aria-haspopup',
      'dialog'
    );

    launcher.innerHTML =
      '<span class="focus-dot" aria-hidden="true"></span>' +
      '<span>Today\'s focus</span>';

    launcher.addEventListener('click', () => {
      open(false);
    });

    (cmdRight || main).prepend(launcher);

    overlay = elt('div', 'daily-focus-overlay');
    overlay.id = ROOT_ID;

    overlay.setAttribute(
      'aria-hidden',
      'true'
    );

    const dialog = elt('div', 'daily-focus-dialog');

    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute(
      'aria-labelledby',
      'dailyFocusTitle'
    );

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        close();
      }
    });

    document.addEventListener('keydown', e => {
      if (!visible) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (e.key !== 'Tab') {
        return;
      }

      const focusable = [
        ...dialog.querySelectorAll(
          'button:not([disabled])'
        )
      ];

      if (!focusable.length) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (
        e.shiftKey &&
        document.activeElement === first
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        document.activeElement === last
      ) {
        e.preventDefault();
        first.focus();
      }
    });

    const stats = document.getElementById('stats');

    if (stats) {
      new MutationObserver(sync).observe(
        stats,
        { childList: true }
      );
    }

    sync();
  }

  function updateButton(tasks) {
    if (!launcher) {
      return;
    }

    const old =
      launcher.querySelector('.focus-count');

    if (old) {
      old.remove();
    }

    if (tasks.length) {
      const count = elt(
        'span',
        'focus-count',
        tasks.length > 99 ? '99+' : tasks.length
      );

      count.setAttribute(
        'aria-label',
        `${tasks.length} pending follow-ups`
      );

      launcher.appendChild(count);
    }
  }

  function sync() {
    if (
      !launcher ||
      typeof leads === 'undefined'
    ) {
      return;
    }

    const tasks = pending();

    updateButton(tasks);

    if (visible) {
      const fingerprint = tasks
        .map(t =>
          `${t.id}:${t.stage}:${t.follow_up_date}`
        )
        .join('|');

      if (fingerprint !== latestFingerprint) {
        renderDialog(tasks);
      }
    }

    const hasAppLoaded =
      !!document.querySelector('#stats .stat');

    const anotherModal =
      !!document.querySelector('.modal-backdrop.open');

    if (
      !autoShown &&
      !wasSeen() &&
      tasks.length &&
      hasAppLoaded &&
      !anotherModal &&
      !visible
    ) {
      open(true);
    }
  }

  function renderDialog(tasks) {
    const dialog = overlay.firstElementChild;
    dialog.replaceChildren();

    latestFingerprint = tasks
      .map(t =>
        `${t.id}:${t.stage}:${t.follow_up_date}`
      )
      .join('|');

    const focus = tasks[0] || null;

    currentFocusId = focus ? focus.id : null;

    const x = elt('button', 'focus-close', '×');
    x.type = 'button';

    x.setAttribute(
      'aria-label',
      'Close daily focus'
    );

    x.addEventListener('click', close);

    dialog.appendChild(x);

    dialog.appendChild(
      elt(
        'p',
        'focus-eyebrow',
        'YOUR DAILY MOMENTUM'
      )
    );

    const title = elt(
      'h2',
      '',
      focus
        ? 'One thing to move forward.'
        : 'You’re all caught up.'
    );

    title.id = 'dailyFocusTitle';

    dialog.appendChild(title);

    dialog.appendChild(
      elt(
        'p',
        'focus-intro',
        focus
          ? 'Your suggested priority, based on overdue follow-ups and lead stage.'
          : 'No follow-ups are due today or overdue. Keep the momentum going.'
      )
    );

    if (focus) {
      const item = elt('div', 'focus-main');

      item.appendChild(
        elt(
          'div',
          'focus-label',
          'SUGGESTED FIRST ACTION'
        )
      );

      item.appendChild(
        elt(
          'h3',
          '',
          focus.name ||
          focus.company ||
          'Unnamed lead'
        )
      );

      const details = [
        focus.company,
        focus.stage,
        focus.assignee
      ]
        .filter(Boolean)
        .join(' · ');

      if (details) {
        item.appendChild(
          elt('p', 'focus-sub', details)
        );
      }

      const dueToday =
        focus.follow_up_date === localDate();

      item.appendChild(
        elt(
          'span',
          `focus-due${dueToday ? ' today' : ''}`,
          `${dueToday ? 'Due today' : 'Overdue'} · ${focus.follow_up_date}`
        )
      );

      dialog.appendChild(item);

      if (tasks.length > 1) {
        const list = elt('ul', 'focus-next');

        tasks.slice(1, 3).forEach(l => {
          const li = elt('li');

          li.appendChild(
            elt(
              'span',
              '',
              l.name ||
              l.company ||
              'Unnamed lead'
            )
          );

          li.appendChild(
            elt(
              'span',
              '',
              l.stage || 'Follow-up'
            )
          );

          list.appendChild(li);
        });

        dialog.appendChild(list);
      }
    }

    const actions = elt('div', 'focus-footer');

    if (focus) {
      const openLead = elt(
        'button',
        'focus-primary',
        'Open priority lead'
      );

      openLead.type = 'button';

      openLead.addEventListener('click', () => {
        const id = currentFocusId;

        close();

        if (
          typeof openDetail === 'function' &&
          id != null
        ) {
          openDetail(id);
        }
      });

      actions.appendChild(openLead);
    }

    const dismiss = elt(
      'button',
      'focus-secondary',
      'Dismiss for today'
    );

    dismiss.type = 'button';
    dismiss.addEventListener('click', close);

    actions.appendChild(dismiss);
    dialog.appendChild(actions);

    dialog.appendChild(
      elt(
        'p',
        'focus-privacy',
        'This suggestion uses existing follow-up dates. It does not mark any task complete or modify customer data.'
      )
    );
  }

  function open(automatic) {
    if (!overlay || visible) {
      return;
    }

    if (
      document.querySelector(
        '.modal-backdrop.open'
      )
    ) {
      return;
    }

    lastTrigger = automatic
      ? document.activeElement
      : launcher;

    renderDialog(pending());

    visible = true;

    markSeen();

    overlay.classList.add('is-open');

    overlay.setAttribute(
      'aria-hidden',
      'false'
    );

    overlay.querySelector('.focus-close')?.focus();
  }

  function close() {
    if (!visible) {
      return;
    }

    visible = false;

    overlay.classList.remove('is-open');

    overlay.setAttribute(
      'aria-hidden',
      'true'
    );

    if (
      lastTrigger &&
      typeof lastTrigger.focus === 'function' &&
      lastTrigger.isConnected
    ) {
      lastTrigger.focus();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      mount,
      { once: true }
    );
  } else {
    mount();
  }
})();
