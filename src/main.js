import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
window.db = db;

let currentSession = null;
let currentView = 'stories';
let currentStoryId = null; // when drilled into a specific story

// Track active realtime subscriptions so we can clean them up.
let activeChannels = [];

function clearChannels() {
  activeChannels.forEach(ch => db.removeChannel(ch));
  activeChannels = [];
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function setUserLabel(label) {
  document.querySelectorAll('.user-email').forEach(el => el.textContent = label);
}

// --- Auth screens ---

function showAuthScreen() {
  document.getElementById('screen-auth').style.display = 'flex';
  document.getElementById('screen-username').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
}
function showUsernameScreen() {
  document.getElementById('screen-auth').style.display = 'none';
  document.getElementById('screen-username').style.display = 'flex';
  document.getElementById('app-shell').style.display = 'none';
}
function showAppShell() {
  document.getElementById('screen-auth').style.display = 'none';
  document.getElementById('screen-username').style.display = 'none';
  document.getElementById('app-shell').style.display = 'grid';
}

document.getElementById('signup-btn').addEventListener('click', async () => {
  const { error } = await db.auth.signUp({
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
  });
  const msg = document.getElementById('auth-message');
  msg.textContent = error ? error.message : 'Signed up! You can log in now.';
});

document.getElementById('login-btn').addEventListener('click', async () => {
  const { error } = await db.auth.signInWithPassword({
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
  });
  if (error) document.getElementById('auth-message').textContent = error.message;
});

function logout() {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('sb-')) localStorage.removeItem(key);
  });
  location.reload();
}
document.querySelectorAll('.logout-btn').forEach(btn =>
  btn.addEventListener('click', logout)
);

// --- Auth state ---

db.auth.onAuthStateChange((event, session) => {
  currentSession = session;
  setTimeout(route, 0);
});

async function route() {
  if (!currentSession) {
    clearChannels();
    showAuthScreen();
    return;
  }

  const profile = await getProfile(currentSession.user.id);
  if (!profile || isAutoUsername(profile.username)) {
    setUserLabel(currentSession.user.email);
    showUsernameScreen();
    return;
  }

  setUserLabel(profile.username);
  showAppShell();
  subscribeToInvitations();
  await refreshInvitationCount();
  await switchView(currentView);
}

function subscribeToInvitations() {
  // Only subscribe once per session.
  if (activeChannels.some(c => c.topic === 'realtime:invitations')) return;

  const channel = db
    .channel('invitations')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'story_invitations', filter: `invitee_id=eq.${currentSession.user.id}` },
      () => {
        refreshInvitationCount();
        if (currentView === 'invitations') renderInvitationsView();
      }
    )
    .subscribe();
  activeChannels.push(channel);
}

async function getProfile(userId) {
  const { data } = await db
    .from('profiles')
    .select('user_id, username')
    .eq('user_id', userId)
    .maybeSingle();
  return data;
}

function isAutoUsername(username) {
  return /_[a-f0-9]{4}$/.test(username);
}

document.getElementById('save-username-btn').addEventListener('click', async () => {
  const username = document.getElementById('username-input').value.trim();
  const msg = document.getElementById('username-message');

  if (username.length < 3) {
    msg.textContent = 'Username must be at least 3 characters.';
    return;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    msg.textContent = 'Letters, numbers, and underscores only.';
    return;
  }

  const { error } = await db
    .from('profiles')
    .update({ username })
    .eq('user_id', currentSession.user.id);

  if (error) {
    msg.textContent = error.code === '23505' ? 'Username already taken.' : error.message;
    return;
  }

  setUserLabel(username)

  showAppShell();
  await refreshInvitationCount();
  await switchView(currentView);
});

// --- Side panel: invitation count ---

async function refreshInvitationCount() {
  const { count } = await db
    .from('story_invitations')
    .select('*', { count: 'exact', head: true })
    .eq('invitee_id', currentSession.user.id)
    .eq('status', 'pending');

  const badge = document.getElementById('invitations-count');
  if (count && count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// --- View switching ---

document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

async function switchView(name) {
  currentView = name;
  currentStoryId = null;

  // Drop story-specific subscriptions when leaving the detail view.
  activeChannels = activeChannels.filter(ch => {
    if (ch.topic.startsWith('realtime:story_')) {
      db.removeChannel(ch);
      return false;
    }
    return true;
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });

  if (name === 'stories') await renderStoriesView();
  else if (name === 'invitations') await renderInvitationsView();
}

// --- Stories view ---

async function renderStoriesView() {
  const main = document.getElementById('main-area-inner');
  main.innerHTML = '<div id="view-loading">Loading...</div>';

  const userId = currentSession.user.id;

  const { data: stories, error } = await db
    .from('stories')
    .select('id, title, visibility_rule, total_rounds, status, creator_id')
    .order('created_at', { ascending: false });

  if (error) {
    main.innerHTML = `<div style="color:#c88;">Error: ${escapeHtml(error.message)}</div>`;
    return;
  }

  const created = (stories || []).filter(s => s.creator_id === userId);
  const joined = (stories || []).filter(s => s.creator_id !== userId);

  main.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
      <h2 style="margin:0;">Stories</h2>
      <button id="create-story-btn">+ Create story</button>
    </div>

    <h3 style="font-family:sans-serif; color:#aaa; font-size:0.95rem;">Stories I created</h3>
    <ul class="story-list">${created.map(renderStoryItem).join('') || '<li class="empty">None yet.</li>'}</ul>

    <h3 style="font-family:sans-serif; color:#aaa; font-size:0.95rem; margin-top:2rem;">Stories I joined</h3>
    <ul class="story-list">${joined.map(renderStoryItem).join('') || '<li class="empty">None yet.</li>'}</ul>
  `;

  document.getElementById('create-story-btn').addEventListener('click', renderCreateStoryView);
  main.querySelectorAll('.story-list li[data-story-id]').forEach(li => {
    li.addEventListener('click', () => renderStoryDetail(li.dataset.storyId));
  });
}

function renderStoryItem(story) {
  return `
    <li data-story-id="${story.id}">
      <div class="story-title">${escapeHtml(story.title)}</div>
      <div class="story-meta">
        ${story.status} · ${story.total_rounds} rounds · ${story.visibility_rule.replace('_', ' ')}
      </div>
    </li>
  `;
}

// --- Create story view ---

function renderCreateStoryView() {
  const main = document.getElementById('main-area-inner');
  main.innerHTML = `
    <h2>Create a story</h2>
    <div class="form-stack">
      <label>Title <input id="story-title" type="text"></label>
      <label>Visibility
        <select id="story-visibility">
          <option value="full">Full story</option>
          <option value="last_paragraph">Last paragraph only</option>
          <option value="last_sentence">Last sentence only</option>
        </select>
      </label>
      <label>Rounds
        <select id="story-rounds">
          <option value="3">3</option>
          <option value="5">5</option>
          <option value="10">10</option>
        </select>
      </label>
      <div class="row">
        <button id="confirm-create-story-btn">Create</button>
        <button id="cancel-create-story-btn">Cancel</button>
      </div>
      <div id="new-story-message"></div>
    </div>
  `;

  document.getElementById('cancel-create-story-btn').addEventListener('click', renderStoriesView);
  document.getElementById('confirm-create-story-btn').addEventListener('click', async () => {
    const title = document.getElementById('story-title').value.trim();
    const visibility = document.getElementById('story-visibility').value;
    const rounds = parseInt(document.getElementById('story-rounds').value, 10);
    const msg = document.getElementById('new-story-message');

    if (!title) {
      msg.textContent = 'Title is required.';
      return;
    }

    const { data: newStory, error } = await db
      .from('stories')
      .insert({
        creator_id: currentSession.user.id,
        title,
        visibility_rule: visibility,
        total_rounds: rounds,
      })
      .select()
      .single();

    if (error) {
      msg.textContent = error.message;
      return;
    }

    const { error: memberError } = await db.from('story_members').insert({
      story_id: newStory.id,
      user_id: currentSession.user.id,
      role: 'creator',
    });

    if (memberError) {
      msg.textContent = 'Story created but member add failed: ' + memberError.message;
      return;
    }

    await renderStoriesView();
  });
}

// --- Story detail view ---

async function renderStoryDetail(storyId) {
  currentStoryId = storyId;

  // Drop subscriptions from any previously-open story (but keep invitations channel).
  activeChannels = activeChannels.filter(ch => {
    if (ch.topic.startsWith('realtime:story_')) {
      db.removeChannel(ch);
      return false;
    }
    return true;
  });

  // Subscribe to all relevant changes for THIS story.
  const channel = db
    .channel(`story_${storyId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'turns', filter: `story_id=eq.${storyId}` },
      () => { if (currentStoryId === storyId) renderStoryDetail(storyId); }
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'characters', filter: `story_id=eq.${storyId}` },
      () => { if (currentStoryId === storyId) renderStoryDetail(storyId); }
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'plot_ideas', filter: `story_id=eq.${storyId}` },
      () => { if (currentStoryId === storyId) renderStoryDetail(storyId); }
    )
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'stories', filter: `id=eq.${storyId}` },
      () => { if (currentStoryId === storyId) renderStoryDetail(storyId); }
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'story_members', filter: `story_id=eq.${storyId}` },
      () => { if (currentStoryId === storyId) renderStoryDetail(storyId); }
    )
    .subscribe();
  activeChannels.push(channel);

  const main = document.getElementById('main-area-inner');
  main.innerHTML = '<div id="view-loading">Loading...</div>';

  const { data: story, error: storyError } = await db
    .from('stories')
    .select('id, title, visibility_rule, total_rounds, status, creator_id')
    .eq('id', storyId)
    .maybeSingle();

  if (storyError || !story) {
    // Story was deleted, or no access — go back to the list.
    currentStoryId = null;
    await switchView('stories');
    return;
  }

  const isCreator = story.creator_id === currentSession.user.id;
  const inBrainstorm = story.status === 'brainstorm';
  const inProgress = story.status === 'in_progress';
  const finished = story.status === 'finished';

  const { data: members } = await db
    .from('story_members')
    .select('role, user_id, profiles(username)')
    .eq('story_id', storyId);

  const { data: characters } = await db
    .from('characters')
    .select('id, name, notes, author_id, profiles(username)')
    .eq('story_id', storyId)
    .order('created_at', { ascending: true });

  const { data: plotIdeas } = await db
    .from('plot_ideas')
    .select('id, content, author_id, profiles(username)')
    .eq('story_id', storyId)
    .order('created_at', { ascending: true });

  let pendingHTML = '';
  if (isCreator && inBrainstorm) {
    const { data: pending } = await db
      .from('story_invitations')
      .select('id, status, invitee_id, profiles!story_invitations_invitee_id_fkey(username)')
      .eq('story_id', storyId)
      .eq('status', 'pending');
    pendingHTML = renderPendingInvitesSection(pending || []);
  }

  let writingHTML = '';
  if (inProgress) {
    const { data: currentAuthorId } = await db.rpc('current_turn_author', { p_story_id: storyId });
    const isMyTurn = currentAuthorId === currentSession.user.id;

    const { data: turnCount } = await db.rpc('turn_count', { p_story_id: storyId });

    const { data: memberCount } = await db.rpc('member_count', { p_story_id: storyId });
    const roundNumber = Math.floor((turnCount || 0) / memberCount) + 1;
    const positionInRound = ((turnCount || 0) % memberCount) + 1;

        console.log('TURN_COUNT raw:', turnCount, '| memberCount:', memberCount, '| round:', roundNumber, '| position:', positionInRound);

    const { data: wordCount } = await db.rpc('story_word_count', { p_story_id: storyId });

    const currentMember = (members || []).find(m => m.user_id === currentAuthorId);
    const currentUsername = currentMember?.profiles?.username || '(unknown)';

    if (isMyTurn) {
      const { data: visibleText } = await db.rpc('visible_text_for_current_writer', { p_story_id: storyId });

      writingHTML = `
        <div class="turn-banner">
          Round ${roundNumber} of ${story.total_rounds} · Your turn · Position ${positionInRound}
        </div>
        ${visibleText ? `
          <div class="visible-text-section">
            <div class="visible-text-label">${story.visibility_rule.replace('_', ' ')}:</div>
            <div class="visible-text">${escapeHtml(visibleText)}</div>
          </div>
        ` : '<div class="visible-text-section"><div class="empty">You\'re writing the opening.</div></div>'}
        <div class="writing-surface">
          <textarea id="turn-input" placeholder="Write your turn..." rows="10"></textarea>
          <div class="writing-bar">
            <span id="turn-word-count">0 words</span>
            <button id="submit-turn-btn">Submit turn</button>
          </div>
          <div id="turn-message"></div>
        </div>
      `;
    } else {
      const canSkip = isCreator && currentAuthorId !== currentSession.user.id;
      writingHTML = `
        <div class="turn-banner">
          Round ${roundNumber} of ${story.total_rounds} · 
          Waiting on <strong>${escapeHtml(currentUsername)}</strong> · 
          Story so far: ${wordCount || 0} words
          ${canSkip ? `<button id="skip-turn-btn" class="link-btn" style="margin-left:1rem;">Skip player</button>` : ''}
        </div>
      `;
    }
  }

  let finishedHTML = '';
  if (finished) {
    const { data: turns } = await db
      .from('turns')
      .select('round_number, turn_in_round, content, skipped, author_id, profiles(username)')
      .eq('story_id', storyId)
      .eq('skipped', false)
      .order('round_number', { ascending: true })
      .order('turn_in_round', { ascending: true });

    const fullText = (turns || []).map(t => t.content).join('\n\n');
    const totalWords = (turns || []).reduce((sum, t) =>
      sum + (t.content?.split(/\s+/).filter(w => w.length > 0).length || 0), 0);

    finishedHTML = `
      <div class="turn-banner" style="border-left-color:#6c6;">
        Finished · ${totalWords} words · ${(turns || []).length} turns
      </div>
      <div class="visible-text-section">
        <div class="visible-text-label">The story</div>
        <div class="visible-text">${escapeHtml(fullText) || '<em>(empty)</em>'}</div>
      </div>
    `;
  }

  main.innerHTML = `
    <button class="link-btn" id="back-btn">← Back to stories</button>
    <h2 style="margin-top:0.5rem;">${escapeHtml(story.title)}</h2>
    <div class="story-meta" style="margin-bottom:1.5rem;">
      ${story.status} · ${story.total_rounds} rounds · ${story.visibility_rule.replace('_', ' ')}
    </div>

    <h3>Members</h3>
    <ul class="members-list">
      ${(members || []).map(m => `
        <li>${escapeHtml(m.profiles?.username || '(unknown)')}<span class="role-tag">${m.role}</span></li>
      `).join('') || '<li class="empty">No members.</li>'}
    </ul>

    ${pendingHTML}

    ${writingHTML}
    ${finishedHTML}

    ${isCreator && inBrainstorm ? `
      <h3>Invite a writer</h3>
      <div class="row">
        <input id="invite-username" type="text" placeholder="username" autocomplete="off">
        <button id="invite-btn">Invite</button>
      </div>
      <div id="invite-message"></div>
    ` : ''}

    <h3 style="margin-top:2rem;">Characters</h3>
    <ul class="brainstorm-list">
      ${(characters || []).map(c => renderCharacterItem(c, story, isCreator, inBrainstorm)).join('') || '<li class="empty">None yet.</li>'}
    </ul>
    ${inBrainstorm ? `
      <div class="form-stack" style="margin-top:1rem;">
        <input id="new-character-name" type="text" placeholder="Character name">
        <textarea id="new-character-notes" placeholder="Notes (optional)" rows="2"></textarea>
        <div class="row"><button id="add-character-btn">Add character</button></div>
        <div id="character-message"></div>
      </div>
    ` : ''}

    <h3 style="margin-top:2rem;">Plot ideas</h3>
    <ul class="brainstorm-list">
      ${(plotIdeas || []).map(p => renderPlotItem(p, story, isCreator, inBrainstorm)).join('') || '<li class="empty">None yet.</li>'}
    </ul>
    ${inBrainstorm ? `
      <div class="form-stack" style="margin-top:1rem;">
        <textarea id="new-plot-content" placeholder="A plot idea..." rows="2"></textarea>
        <div class="row"><button id="add-plot-btn">Add plot idea</button></div>
        <div id="plot-message"></div>
      </div>
    ` : ''}

    ${isCreator && inBrainstorm ? `
      <div style="margin-top:2.5rem; padding-top:1.5rem; border-top:1.5px solid var(--line);">
        <button id="start-story-btn" class="primary">Start story</button>
        <div style="font-size:0.85rem; color:var(--ink-dim); margin-top:0.5rem;">
          Once started, brainstorm is locked and turns begin.
        </div>
      </div>
    ` : ''}

    ${isCreator ? `
      <div style="margin-top:2rem; padding-top:1.5rem; border-top:2px dashed var(--navy);">
        ${inProgress ? `
          <div style="margin-bottom:0.85rem;">
            <button id="force-end-btn">Force end story</button>
            <div style="font-size:0.9rem; color:var(--ink-dim); margin-top:0.4rem; font-family:'VT323', monospace;">
              Ends the story immediately and reveals the full text to everyone.
            </div>
          </div>
        ` : ''}
        <button id="delete-story-btn">Delete story</button>
        <div style="font-size:0.9rem; color:var(--ink-dim); margin-top:0.4rem; font-family:'VT323', monospace;">
          Permanently deletes the story, its turns, characters, and invitations.
        </div>
      </div>
    ` : ''}
  `;

  // Wire up event handlers
  document.getElementById('back-btn').addEventListener('click', renderStoriesView);

  if (isCreator && inBrainstorm) {
    document.getElementById('invite-btn')?.addEventListener('click', () => sendInvite(storyId));
    main.querySelectorAll('.cancel-invite-btn').forEach(btn => {
      btn.addEventListener('click', () => cancelInvite(btn.dataset.inviteId, storyId));
    });
    document.getElementById('start-story-btn').addEventListener('click', () => startStory(storyId));
  }

  if (inBrainstorm) {
    document.getElementById('add-character-btn').addEventListener('click', () => addCharacter(storyId));
    document.getElementById('add-plot-btn').addEventListener('click', () => addPlotIdea(storyId));
  }

  if (isCreator && inBrainstorm) {
    main.querySelectorAll('.delete-character-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteCharacter(btn.dataset.id, storyId));
    });
    main.querySelectorAll('.delete-plot-btn').forEach(btn => {
      btn.addEventListener('click', () => deletePlotIdea(btn.dataset.id, storyId));
    });
  }

  if (inProgress) {
    const input = document.getElementById('turn-input');
    if (input) {
      input.addEventListener('input', () => {
        const words = input.value.trim().split(/\s+/).filter(w => w.length > 0).length;
        document.getElementById('turn-word-count').textContent = `${words} words`;
      });
      document.getElementById('submit-turn-btn').addEventListener('click', () => submitTurn(storyId));
    }
    document.getElementById('skip-turn-btn')?.addEventListener('click', () => skipCurrentTurn(storyId));
    document.getElementById('force-end-btn')?.addEventListener('click', () => forceEndStory(storyId));
  }

  document.getElementById('delete-story-btn')?.addEventListener('click', () => deleteStory(storyId, story.title));
}


// User submits input and ends turn

async function submitTurn(storyId) {
  const input = document.getElementById('turn-input');
  const msg = document.getElementById('turn-message');
  const content = input.value.trim();
  msg.textContent = '';

  if (!content) {
    msg.textContent = 'Write something first.';
    return;
  }

  const { error } = await db.rpc('submit_turn', {
    p_story_id: storyId,
    p_content: content,
  });

  if (error) {
    msg.textContent = error.message;
    return;
  }

  await renderStoryDetail(storyId);
}

// Skip user
async function skipCurrentTurn(storyId) {
  const confirmed = confirm("Skip the current player's turn? Their slot will be left empty.");
  if (!confirmed) return;

  const { error } = await db.rpc('skip_current_turn', { p_story_id: storyId });

  if (error) {
    alert('Failed to skip: ' + error.message);
    return;
  }

  await renderStoryDetail(storyId);
}

// Lets creator force story end
async function forceEndStory(storyId) {
  const confirmed = confirm("End this story now? All members will see the full story text.");
  if (!confirmed) return;

  const { error } = await db.rpc('force_end_story', { p_story_id: storyId });
  if (error) {
    alert('Failed to end story: ' + error.message);
    return;
  }
  await renderStoryDetail(storyId);
}

// Lets creator delete stories
async function deleteStory(storyId, title) {
  const confirmed = confirm(`Delete "${title}"?\n\nThis permanently deletes the story, all submitted turns, characters, plot ideas, and pending invitations. It cannot be undone.`);
  if (!confirmed) return;

  // Clear story subscription before deleting so we don't get phantom realtime events.
  activeChannels = activeChannels.filter(ch => {
    if (ch.topic.startsWith('realtime:story_')) {
      db.removeChannel(ch);
      return false;
    }
    return true;
  });
  currentStoryId = null;

  const { error } = await db.rpc('delete_story', { p_story_id: storyId });
  if (error) {
    alert('Failed to delete: ' + error.message);
    return;
  }

  await switchView('stories');
}

function renderCharacterItem(c, story, isCreator, inBrainstorm) {
  const author = c.profiles?.username || '(unknown)';
  const canDelete = isCreator && inBrainstorm;
  return `
    <li>
      <div class="brainstorm-title">${escapeHtml(c.name)}</div>
      ${c.notes ? `<div class="brainstorm-body">${escapeHtml(c.notes)}</div>` : ''}
      <div class="brainstorm-meta">
        added by ${escapeHtml(author)}
        ${canDelete ? `<button class="link-btn delete-character-btn" data-id="${c.id}">delete</button>` : ''}
      </div>
    </li>
  `;
}

function renderPlotItem(p, story, isCreator, inBrainstorm) {
  const author = p.profiles?.username || '(unknown)';
  const canDelete = isCreator && inBrainstorm;
  return `
    <li>
      <div class="brainstorm-body">${escapeHtml(p.content)}</div>
      <div class="brainstorm-meta">
        added by ${escapeHtml(author)}
        ${canDelete ? `<button class="link-btn delete-plot-btn" data-id="${p.id}">delete</button>` : ''}
      </div>
    </li>
  `;
}

function renderPendingInvitesSection(pending) {
  if (pending.length === 0) {
    return '<h3>Pending invitations</h3><div class="empty">None.</div>';
  }
  return `
    <h3>Pending invitations</h3>
    <ul class="members-list">
      ${pending.map(p => `
        <li>
          ${escapeHtml(p.profiles?.username || '(unknown)')}
          <button class="link-btn cancel-invite-btn" data-invite-id="${p.id}">Cancel</button>
        </li>
      `).join('')}
    </ul>
  `;
}

async function sendInvite(storyId) {
  const username = document.getElementById('invite-username').value.trim();
  const msg = document.getElementById('invite-message');
  msg.textContent = '';

  if (!username) return;

  const { data: profile } = await db
    .from('profiles')
    .select('user_id, username')
    .eq('username', username)
    .maybeSingle();

  if (!profile) {
    msg.textContent = `No user with username "${username}".`;
    return;
  }
  if (profile.user_id === currentSession.user.id) {
    msg.textContent = "You can't invite yourself.";
    return;
  }

  const { error } = await db.from('story_invitations').insert({
    story_id: storyId,
    invitee_id: profile.user_id,
    inviter_id: currentSession.user.id,
  });

  if (error) {
    msg.textContent = error.code === '23505' ? `${username} already has a pending invite.` : error.message;
    return;
  }

  await renderStoryDetail(storyId);
}

async function cancelInvite(inviteId, storyId) {
  await db
    .from('story_invitations')
    .update({ status: 'cancelled', responded_at: new Date().toISOString() })
    .eq('id', inviteId);
  await renderStoryDetail(storyId);
}

async function addCharacter(storyId) {
  const name = document.getElementById('new-character-name').value.trim();
  const notes = document.getElementById('new-character-notes').value.trim();
  const msg = document.getElementById('character-message');
  msg.textContent = '';

  if (!name) {
    msg.textContent = 'Name is required.';
    return;
  }

  const { error } = await db.from('characters').insert({
    story_id: storyId,
    author_id: currentSession.user.id,
    name,
    notes,
  });

  if (error) {
    msg.textContent = error.message;
    return;
  }

  await renderStoryDetail(storyId);
}

async function deleteCharacter(id, storyId) {
  await db.from('characters').delete().eq('id', id);
  await renderStoryDetail(storyId);
}

async function addPlotIdea(storyId) {
  const content = document.getElementById('new-plot-content').value.trim();
  const msg = document.getElementById('plot-message');
  msg.textContent = '';

  if (!content) {
    msg.textContent = 'Plot idea is required.';
    return;
  }

  const { error } = await db.from('plot_ideas').insert({
    story_id: storyId,
    author_id: currentSession.user.id,
    content,
  });

  if (error) {
    msg.textContent = error.message;
    return;
  }

  await renderStoryDetail(storyId);
}

async function deletePlotIdea(id, storyId) {
  await db.from('plot_ideas').delete().eq('id', id);
  await renderStoryDetail(storyId);
}

async function startStory(storyId) {
  const confirmed = confirm("Start the story? Brainstorm will be locked and you can't add more characters or plot ideas after this.");
  if (!confirmed) return;

  // Fetch all members of the story.
  const { data: members, error: memberError } = await db
    .from('story_members')
    .select('user_id')
    .eq('story_id', storyId);

  if (memberError) {
    alert('Failed to fetch members: ' + memberError.message);
    return;
  }
  if (!members || members.length < 1) {
    alert('Story needs at least one member to start.');
    return;
  }

  // Shuffle and assign turn_order.
  const shuffled = [...members].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i++) {
    const { error } = await db
      .from('story_members')
      .update({ turn_order: i + 1 })
      .eq('story_id', storyId)
      .eq('user_id', shuffled[i].user_id);
    if (error) {
      alert('Failed to assign turn order: ' + error.message);
      return;
    }
  }

  // Flip status to in_progress.
  const { error: statusError } = await db
    .from('stories')
    .update({ status: 'in_progress' })
    .eq('id', storyId);

  if (statusError) {
    alert('Failed to start story: ' + statusError.message);
    return;
  }

  await renderStoryDetail(storyId);
}

// --- Invitations view ---

async function renderInvitationsView() {
  const main = document.getElementById('main-area-inner');
  main.innerHTML = '<div id="view-loading">Loading...</div>';

  const { data: invites, error } = await db
    .from('story_invitations')
    .select('id, status, story_id, stories(title, total_rounds, visibility_rule), profiles!story_invitations_inviter_id_fkey(username)')
    .eq('invitee_id', currentSession.user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    main.innerHTML = `<div style="color:#c88;">Error: ${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!invites || invites.length === 0) {
    main.innerHTML = `<h2>Invitations</h2><div class="empty">No pending invitations.</div>`;
    return;
  }

  main.innerHTML = `
    <h2>Invitations</h2>
    <ul class="invites-list">
      ${invites.map(i => `
        <li>
          <div class="story-title">${escapeHtml(i.stories?.title || '(deleted story)')}</div>
          <div class="story-meta">
            from ${escapeHtml(i.profiles?.username || '(unknown)')} · 
            ${i.stories?.total_rounds || '?'} rounds · 
            ${(i.stories?.visibility_rule || '').replace('_', ' ')}
          </div>
          <div class="row" style="margin-top:0.5rem;">
            <button class="accept-btn" data-invite-id="${i.id}" data-story-id="${i.story_id}">Accept</button>
            <button class="decline-btn" data-invite-id="${i.id}">Decline</button>
          </div>
        </li>
      `).join('')}
    </ul>
  `;

  main.querySelectorAll('.accept-btn').forEach(btn => {
    btn.addEventListener('click', () => acceptInvite(btn.dataset.inviteId, btn.dataset.storyId));
  });
  main.querySelectorAll('.decline-btn').forEach(btn => {
    btn.addEventListener('click', () => declineInvite(btn.dataset.inviteId));
  });
}

async function acceptInvite(inviteId, storyId) {
  // Add to story_members and mark invitation accepted.
  const { error: memberError } = await db.from('story_members').insert({
    story_id: storyId,
    user_id: currentSession.user.id,
    role: 'writer',
  });

  if (memberError && memberError.code !== '23505') {
    console.error('Failed to add member:', memberError);
    return;
  }

  await db
    .from('story_invitations')
    .update({ status: 'accepted', responded_at: new Date().toISOString() })
    .eq('id', inviteId);

  await refreshInvitationCount();
  await renderInvitationsView();
}

async function declineInvite(inviteId) {
  await db
    .from('story_invitations')
    .update({ status: 'declined', responded_at: new Date().toISOString() })
    .eq('id', inviteId);

  await refreshInvitationCount();
  await renderInvitationsView();
}