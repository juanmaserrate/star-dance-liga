// Wizards "Mis Alumnas": cargar alumna e inscribir en torneo (fullscreen, minimizables)
document.addEventListener('DOMContentLoaded', () => {
  const overlays = document.querySelectorAll('.wizard-overlay');

  function openWizard(id, studentId) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.remove('is-minimized');
    overlay.classList.add('is-open');
    overlay.querySelector('.wizard-body').style.display = 'block';
    if (studentId && id === 'wizardInscribir') {
      preSelectStudent(studentId);
    }
  }

  function closeWizard(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.remove('is-open');
  }

  function toggleMinimize(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.toggle('is-minimized');
    const btn = overlay.querySelector('.wizard-min');
    if (btn) btn.textContent = overlay.classList.contains('is-minimized') ? '□' : '—';
  }

  // Open buttons
  document.querySelectorAll('[data-open-wizard]').forEach(btn => {
    btn.addEventListener('click', () => {
      openWizard(btn.getAttribute('data-open-wizard'), btn.getAttribute('data-student-id'));
    });
  });

  // Close buttons
  document.querySelectorAll('[data-close-wizard]').forEach(btn => {
    btn.addEventListener('click', () => {
      closeWizard(btn.getAttribute('data-close-wizard'));
    });
  });

  // Min/Close header controls
  document.querySelectorAll('.wizard-close').forEach(btn => {
    btn.addEventListener('click', () => closeWizard(btn.getAttribute('data-wizard')));
  });
  document.querySelectorAll('.wizard-min').forEach(btn => {
    btn.addEventListener('click', () => toggleMinimize(btn.getAttribute('data-wizard')));
  });

  // Click on translucent backdrop closes (unless minimized)
  overlays.forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && !overlay.classList.contains('is-minimized')) {
        closeWizard(overlay.id);
      }
    });
  });

  function showResult(id, ok, message) {
    const box = document.getElementById(id);
    if (!box) return;
    box.style.display = 'block';
    box.className = 'wizard-result ' + (ok ? 'wizard-result-ok' : 'wizard-result-err');
    box.textContent = (ok ? '✅ ' : '⚠️ ') + message;
  }

  // ---- Wizard: Cargar Nueva Alumna ----
  const formAlumna = document.getElementById('formNuevaAlumna');
  if (formAlumna) {
    formAlumna.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = formAlumna.querySelector('button[type="submit"]');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Guardando...';

      try {
        const fd = new FormData(formAlumna);
        const resp = await fetch('/profesor/alumnos/nuevo', {
          method: 'POST',
          headers: { 'Accept': 'application/json' },
          body: fd
        });
        const data = await resp.json().catch(() => ({ ok: false, message: 'Respuesta inválida del servidor.' }));
        if (!resp.ok || !data.ok) {
          showResult('resultNuevaAlumna', false, data.message || 'No se pudo registrar la patinadora.');
        } else {
          showResult('resultNuevaAlumna', true, data.message || 'Patinadora cargada.');
          setTimeout(() => window.location.reload(), 900);
        }
      } catch (err) {
        showResult('resultNuevaAlumna', false, 'Error de conexión. Intentalo de nuevo.');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  // ---- Wizard: Inscribir a Torneo ----
  const data = window.WIZARDS_DATA || { tournaments: [], categories: [] };
  const tournamentSel = document.getElementById('in_tournament');
  const disciplineSel = document.getElementById('in_discipline');
  const categorySel = document.getElementById('in_category');
  const groupTypeSel = document.getElementById('in_group_type');
  const groupNameBox = document.getElementById('in_group_name_box');
  const studentChecks = () => Array.from(document.querySelectorAll('#in_students input[name="student_ids"]'));

  function filterDisciplines() {
    const tid = tournamentSel ? tournamentSel.value : '';
    if (!disciplineSel) return;
    disciplineSel.innerHTML = '<option value="">-- Seleccionar Disciplina --</option>';
    if (!tid) {
      disciplineSel.disabled = true;
      if (categorySel) {
        categorySel.innerHTML = '<option value="">-- Primero elegí un torneo --</option>';
        categorySel.disabled = true;
      }
      return;
    }
    const disciplines = [...new Set(
      data.categories
        .filter(c => String(c.tournament_id) === String(tid))
        .map(c => c.discipline)
        .filter(Boolean)
    )].sort();
    disciplines.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      disciplineSel.appendChild(opt);
    });
    disciplineSel.disabled = false;
    if (disciplines.length === 1) disciplineSel.value = disciplines[0];
    filterCategories();
  }

  function filterCategories() {
    const tid = tournamentSel ? tournamentSel.value : '';
    const disc = disciplineSel ? disciplineSel.value : '';
    if (!categorySel) return;
    categorySel.innerHTML = '<option value="">-- Seleccionar Categoría --</option>';
    if (!tid || !disc) {
      categorySel.disabled = true;
      return;
    }
    data.categories
      .filter(c => String(c.tournament_id) === String(tid) && c.discipline === disc)
      .forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.setAttribute('data-discipline', c.discipline || '');
        opt.textContent = `${c.name} (${c.min_age}-${c.max_age} años) - Arancel: $${c.fee}`;
        categorySel.appendChild(opt);
      });
    categorySel.disabled = false;
  }

  function updateGroupUI() {
    if (!groupTypeSel || !groupNameBox) return;
    const isGroup = groupTypeSel.value !== 'Individual';
    const checked = studentChecks().filter(c => c.checked).length;
    groupNameBox.style.display = (isGroup || checked > 1) ? 'block' : 'none';
  }

  if (tournamentSel) {
    tournamentSel.addEventListener('change', filterDisciplines);
  }
  if (disciplineSel) {
    disciplineSel.addEventListener('change', filterCategories);
  }
  if (categorySel) {
    categorySel.addEventListener('change', () => {
      const opt = categorySel.options[categorySel.selectedIndex];
      if (!opt || !groupTypeSel) return;
      const disc = (opt.getAttribute('data-discipline') || '').toUpperCase();
      if (disc.includes('DÚO')) groupTypeSel.value = 'Dúo';
      else if (disc.includes('TRÍO')) groupTypeSel.value = 'Trío';
      else if (disc.includes('CUARTETO')) groupTypeSel.value = 'Cuarteto';
      else if (disc.includes('PAREJA')) groupTypeSel.value = 'Parejas Mixtas';
      else if (disc.includes('SMALL')) groupTypeSel.value = 'Small';
      else if (disc.includes('SHOW')) groupTypeSel.value = 'Show';
      else if (disc.includes('PRECISIÓN')) groupTypeSel.value = 'Precisión';
      else groupTypeSel.value = 'Individual';
      updateGroupUI();
    });
  }
  if (groupTypeSel) {
    groupTypeSel.addEventListener('change', updateGroupUI);
  }
  studentChecks().forEach(c => c.addEventListener('change', updateGroupUI));

  function preSelectStudent(id) {
    if (tournamentSel && data.tournaments.length > 0) {
      tournamentSel.value = data.tournaments[0].id;
      filterDisciplines();
    }
    const checks = studentChecks();
    checks.forEach(c => { c.checked = (String(c.value) === String(id)); });
    updateGroupUI();
  }

  const formInscribir = document.getElementById('formInscribir');
  if (formInscribir) {
    formInscribir.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = formInscribir.querySelector('button[type="submit"]');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Procesando...';

      const selected = studentChecks().filter(c => c.checked).map(c => c.value);

      const payload = {
        tournament_id: tournamentSel.value,
        category_id: categorySel.value,
        group_type: groupTypeSel.value,
        is_group: (groupTypeSel.value !== 'Individual' || selected.length > 1) ? '1' : '0',
        group_name: document.getElementById('in_group_name') ? document.getElementById('in_group_name').value : '',
        notes: document.getElementById('in_notes') ? document.getElementById('in_notes').value : '',
        student_ids: selected
      };

      try {
        const resp = await fetch('/profesor/inscribir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data2 = await resp.json().catch(() => ({ ok: false, message: 'Respuesta inválida del servidor.' }));
        if (!resp.ok || !data2.ok) {
          showResult('resultInscribir', false, data2.message || 'No se pudo realizar la inscripción.');
        } else {
          showResult('resultInscribir', true, data2.message || 'Inscripción realizada.');
          formInscribir.style.display = 'none';
        }
      } catch (err) {
        showResult('resultInscribir', false, 'Error de conexión. Intentalo de nuevo.');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }
});
