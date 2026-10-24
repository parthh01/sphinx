import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, writeJson } from '../src/config.js';
import { createSessionStore, savedDraft, sessionFile } from '../src/sessions.js';
import { OpenRouterError } from '../src/openrouter.js';

const q={id:'retry',concept:'idempotency',prompt:'Can a repeated request duplicate the operation? Give the cause.',choices:['Yes','No'],expectedAnswer:'Yes: no deduplication.',rationale:'The insert happens on every call.',evidence:[{path:'src/order.js',reason:'An unconditional insert.'}]};
const snapshot={id:'a'.repeat(64),repoRoot:'/test/repo',repoId:'r',event:'pre-push',target:{ref:'refs/heads/main'},files:['src/order.js'],evidence:'insert()',stats:{additions:10,deletions:1,files:1}};
async function fixture(t, extra={}) {
  const home=await mkdtemp(path.join(tmpdir(),'sphinx-sessions-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const env={SPHINX_HOME:home};
  const config=structuredClone(DEFAULT_CONFIG);
  const rawGenerate=extra.generate || (async()=>({questions:[structuredClone(q)]}));
  const rawGrade=extra.grade || (async()=>({verdict:'correct',feedback:'Correct: the repeated insert can duplicate it.',followUp:null}));
  const firstCharged = beforeCall => { let first=true; return async()=>{if(first){first=false;return;}await beforeCall();}; };
  const store=createSessionStore({env,...extra,
    generate:async(s,c,options)=>{await options.beforeCall();return rawGenerate(s,c,{...options,beforeCall:firstCharged(options.beforeCall)});},
    grade:async request=>{await request.beforeCall();return rawGrade({...request,beforeCall:firstCharged(request.beforeCall)});},
  });
  return {store,env,config};
}

test('pending is free, approval is reusable and public output never contains the answer key',async t=>{
  let calls=0;
  const {store,env,config}=await fixture(t,{generate:async()=>{calls++;return{questions:[q]};}});
  await store.ensure(snapshot,config);
  assert.equal(calls,0);
  assert.equal(await store.approved(snapshot,config),false);
  const state=await store.start(snapshot.id,config);
  assert.equal(calls,1);
  assert.equal(JSON.stringify(state).includes('expectedAnswer'),false);
  assert.equal(JSON.stringify(state).includes(q.rationale),false);
  await store.start(snapshot.id,config);
  assert.equal(calls,1);
  assert.equal((await store.answer(snapshot.id,'Yes: it inserts every time.',config)).status,'passed');
  assert.equal(await store.approved(snapshot,config),true);
  assert.equal((await store.start(snapshot.id,config)).status,'passed');
  assert.equal(calls,1);
  assert.equal((await stat(sessionFile(snapshot.id,env))).mode & 0o777,0o600);
  assert.equal(await store.approved({...snapshot,id:'b'.repeat(64)},config),false);
});

test('a misconception produces a new scenario and only a later correct answer completes the concept',async t=>{
  let attempt=0;
  const followUp={...q,id:'timeout',prompt:'The connection drops after insertion. Can retry insert again? Why?'};
  const {store,config}=await fixture(t,{grade:async()=>++attempt===1?{verdict:'incorrect',feedback:'There is no key to deduplicate.',followUp}:{verdict:'correct',feedback:'That accounts for the retry.',followUp:null}});
  await store.ensure(snapshot,config);await store.start(snapshot.id,config);
  const missed=await store.answer(snapshot.id,'No.',config);
  assert.equal(missed.status,'active');assert.equal(missed.progress.completed,0);assert.equal(missed.question.id,'timeout');
  assert.equal((await store.answer(snapshot.id,'Yes, both attempts insert.',config)).status,'passed');
});

test('answer-bearing concept and acceptance metadata stay private through public questions and transfer grading', async t => {
  const concept = 'PRIVATE_CONCEPT_ANSWER: yes, every retry repeats the unconditional insert.';
  const acceptance = { prediction: 'PRIVATE_ACCEPTANCE_PREDICTION: A retry can insert another row.', causalReason: 'PRIVATE_ACCEPTANCE_CAUSE: The insert runs again without a duplicate check.' };
  const original = { ...q, concept, acceptance };
  const followUp = { ...original, id: 'after-timeout', prompt: 'After an insertion times out, could a new request insert again? Explain why.',
    acceptance: { prediction: 'PRIVATE_ACCEPTANCE_TRANSFER: Another row can be inserted after the timeout.', causalReason: 'PRIVATE_ACCEPTANCE_CAUSE: The first insert can finish before the new request repeats it.' } };
  const graded = [];
  const { store, config } = await fixture(t, {
    generate: async () => ({ questions: [original] }),
    grade: async request => {
      graded.push(request.question);
      return graded.length === 1
        ? { verdict: 'incorrect', feedback: 'Consider what happens on the next request.', followUp }
        : { verdict: 'correct', feedback: 'Correct.', followUp: null };
    },
  });
  await store.ensure(snapshot, config);
  const first = await store.start(snapshot.id, config);
  assert.deepEqual(first.question, { id: original.id, prompt: original.prompt, choices: original.choices });
  assert.equal((await store.read(snapshot.id)).questions[0].concept, concept);
  assert.deepEqual((await store.read(snapshot.id)).questions[0].acceptance, acceptance);
  const next = await store.answer(snapshot.id, 'No.', config);
  assert.equal(next.question.id, followUp.id);
  assert.equal((await store.read(snapshot.id)).questions[0].concept, concept);
  assert.deepEqual((await store.read(snapshot.id)).questions[0].acceptance, followUp.acceptance);
  const pending = (await store.pending(snapshot.repoRoot)).map(store.public);
  assert.doesNotMatch(JSON.stringify([first, next, pending]), /PRIVATE_CONCEPT_ANSWER|PRIVATE_ACCEPTANCE|"concept"|"acceptance"/);
  assert.equal((await store.answer(snapshot.id, 'Yes, every retry inserts again.', config)).status, 'passed');
  assert.deepEqual(graded.map(question => question.concept), [concept, concept]);
  assert.deepEqual(graded.map(question => question.acceptance), [acceptance, followUp.acceptance]);
});

test('ambiguous grading does not produce a receipt',async t=>{
  const {store,config}=await fixture(t,{grade:async()=>({verdict:'ambiguous',feedback:'The schema is missing.',followUp:null})});
  await store.ensure(snapshot,config);await store.start(snapshot.id,config);
  assert.equal((await store.answer(snapshot.id,'There may be a unique index.',config)).status,'active');
  assert.equal(await store.approved(snapshot,config),false);
});

test('learning and dispute requests cannot award a pass',async t=>{
  const {store,config}=await fixture(t);
  await store.ensure(snapshot,config);await store.start(snapshot.id,config);
  await assert.rejects(store.answer(snapshot.id,'Teach me.',config,{learn:true}),/cannot complete/);
  await assert.rejects(store.answer(snapshot.id,'The premise is wrong.',config,{dispute:true}),/cannot complete/);
  assert.equal(await store.approved(snapshot,config),false);
});

test('cancellation during receipt persistence rolls back progress and cannot release another Git process', async t => {
  for (const timing of ['before rename', 'after rename']) await t.test(timing, async t => {
    const controller = new AbortController();
    const { store, env, config } = await fixture(t);
    await store.ensure(snapshot, config);
    await store.start(snapshot.id, config);
    const file = sessionFile(snapshot.id, env), originalRename = fsPromises.rename;
    let intercepted = false;
    t.mock.method(fsPromises, 'rename', async (from, to) => {
      const pending = to === file ? JSON.parse(await fsPromises.readFile(from, 'utf8')) : null;
      if (pending?.status !== 'passed') return originalRename(from, to);
      intercepted = true;
      if (timing === 'before rename') controller.abort();
      await originalRename(from, to);
      if (timing === 'after rename') controller.abort();
      assert.equal(await store.approved(snapshot, config), false, 'an in-flight receipt must not release another Git process');
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(store.answer(snapshot.id, 'Yes: each request inserts.', config, { signal: controller.signal }), /abort/i);
    assert.equal(intercepted, true);
    const saved = await store.read(snapshot.id);
    assert.equal(saved.status, 'active');
    assert.equal(saved.index, 0);
    assert.equal(saved.expiresAt, null);
    assert.equal(saved.attempts.length, 0);
    assert.equal(saved.calls, 2, 'the already incurred grading call remains counted');
    assert.equal(await store.approved(snapshot, config), false);
    assert.deepEqual((await fsPromises.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
  });
});

test('failed generation consumes a call and a budget limit prevents further calls',async t=>{
  let calls=0;
  const {store,config}=await fixture(t,{generate:async()=>{calls++;throw new Error('Unavailable');}});
  config.maxModelCalls=3;
  await store.ensure(snapshot,config);
  await assert.rejects(store.start(snapshot.id,config),/Unavailable/);
  await assert.rejects(store.start(snapshot.id,config),/call limit/);
  assert.equal(calls,1);assert.equal(await store.approved(snapshot,config),false);
});

test('policy changes and expired receipts require a new assessment',async t=>{
  const {store,env,config}=await fixture(t);
  await store.ensure(snapshot,config);await store.start(snapshot.id,config);await store.answer(snapshot.id,'Yes.',config);
  assert.equal(await store.approved(snapshot,{...config,level:'thorough'}),false);
  const record=await store.read(snapshot.id);record.expiresAt='2000-01-01T00:00:00.000Z';
  await writeJson(sessionFile(snapshot.id,env),record);
  assert.equal(await store.approved(snapshot,config),false);
  assert.equal((await store.ensure(snapshot,config)).status,'pending');
});

test('stale snapshots fail before generation and again before recording completion',async t=>{
  let changed=false;
  const {store,config}=await fixture(t,{validate:async()=>{if(changed)throw new Error('Changed');},grade:async()=>{changed=true;return{verdict:'correct',feedback:'Correct.',followUp:null};}});
  await store.ensure(snapshot,config);await store.start(snapshot.id,config);
  await assert.rejects(store.answer(snapshot.id,'Yes.',config),/Changed/);
  assert.equal(await store.approved(snapshot,config),false);
});

test('parallel operations share an exclusive session lock',async t=>{
  let unblock, entered;
  const ready=new Promise(r=>{entered=r;});
  const held=new Promise(r=>{unblock=r;});
  const {store,config}=await fixture(t,{generate:async()=>{entered();await held;return{questions:[q]};}});
  await store.ensure(snapshot,config);
  const first=store.start(snapshot.id,config);await ready;
  await assert.rejects(store.prepare(snapshot.id,config),/already running/);
  unblock();await first;
});

test('a recent partial lock stays exclusive and an old orphaned lock can recover',async t=>{
  const {store,env,config}=await fixture(t);
  await store.ensure(snapshot,config);
  const lock=`${sessionFile(snapshot.id,env)}.lock`;
  await writeFile(lock,'',{mode:0o600});
  await assert.rejects(store.prepare(snapshot.id,config),/already running/);
  const old=new Date(Date.now()-60000);
  await utimes(lock,old,old);
  assert.equal((await store.prepare(snapshot.id,config)).status,'active');
});

test('an old lock still protects a live reviewer without spending another model call',async t=>{
  const {store,env,config}=await fixture(t);
  await store.ensure(snapshot,config);
  const lock=`${sessionFile(snapshot.id,env)}.lock`;
  await writeFile(lock,JSON.stringify({pid:process.pid}),{mode:0o600});
  const old=new Date(Date.now()-60000);
  await utimes(lock,old,old);
  await assert.rejects(store.prepare(snapshot.id,config),/already running/);
  assert.equal((await store.read(snapshot.id)).calls,0);
});

test('preparation charges each actual request, reuses questions, and cannot approve a checkpoint',async t=>{
  let generations=0,grades=0;
  const review={version:1,summary:'Reviewed retry handling.',evidence:'insert()',evidencePaths:['src/order.js'],toolCalls:2,compactions:1};
  const {store,config}=await fixture(t,{
    generate:async(_snapshot,_config,{beforeCall,maxReviewerCalls})=>{
      generations++; assert.ok(maxReviewerCalls===null||maxReviewerCalls>=3);
      await beforeCall(); await beforeCall(); await beforeCall();
      return{questions:[q],review};
    },
    grade:async request=>{grades++;assert.deepEqual(request.review,review);await request.beforeCall();return{verdict:'correct',feedback:'Correct.',followUp:null};},
  });
  await store.ensure(snapshot,config);
  const prepared=await store.prepare(snapshot.id,config);
  assert.equal(prepared.status,'active');assert.equal(prepared.preparation.status,'ready');
  assert.equal(prepared.usage.calls,3);assert.equal(await store.approved(snapshot,config),false);
  await store.start(snapshot.id,config);await store.prepare(snapshot.id,config);
  assert.equal(generations,1);assert.equal((await store.read(snapshot.id)).calls,3);
  const result=await store.answer(snapshot.id,'Yes, the insertion repeats.',config);
  assert.equal(result.status,'passed');assert.equal(result.usage.calls,4);assert.equal(grades,1);
});

test('foreground waits for preparation and the Git gate can inspect its session without starting another review',async t=>{
  let release,entered,calls=0;
  const ready=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const {store,config}=await fixture(t,{generate:async(_s,_c,{beforeCall})=>{calls++;await beforeCall();entered();await hold;return{questions:[q]};}});
  await store.ensure(snapshot,config);
  const background=store.prepare(snapshot.id,config);await ready;
  assert.equal((await store.ensure(snapshot,config)).preparation.status,'running');
  const foreground=store.start(snapshot.id,config);
  release();await background;
  assert.equal((await foreground).question.id,q.id);assert.equal(calls,1);
});

test('reviewer cannot consume the calls reserved for human grading',async t=>{
  let invoked=0;
  const {store,config}=await fixture(t,{generate:async(_s,_c,{beforeCall})=>{
    for(let i=0;i<5;i++){await beforeCall();invoked++;}
    return{questions:[q]};
  }});
  config.maxModelCalls=3;
  await store.ensure(snapshot,config);
  await assert.rejects(store.prepare(snapshot.id,config),/Reviewer call limit/);
  assert.equal(invoked,2);assert.equal((await store.read(snapshot.id)).calls,2);
  assert.equal(await store.approved(snapshot,config),false);
});

test('session IDs cannot escape the state directory',()=>{
  assert.throws(()=>sessionFile('../../credentials'),/Invalid assessment/);
});

test('question identity is checked under the lock before a stale answer consumes a call',async t=>{
  let grades=0;
  const {store,config}=await fixture(t,{grade:async()=>{grades++;return{verdict:'incorrect',feedback:'Retry.',followUp:{...q,id:'new-scenario',prompt:'Can retrying the job repeat the insert?'}};}});
  await store.ensure(snapshot,config);await store.start(snapshot.id,config);
  await store.answer(snapshot.id,'No.',config,{expectedQuestionId:q.id});
  await assert.rejects(store.answer(snapshot.id,'Stale answer.',config,{expectedQuestionId:q.id}),error=>error.code==='SPHINX_STALE_QUESTION');
  assert.equal(grades,1);assert.equal((await store.read(snapshot.id)).calls,2);
});

test('cancellation during generation or grading never stores completion',async t=>{
  const generation=new AbortController();
  const {store,config}=await fixture(t,{generate:async()=>{generation.abort();return{questions:[q]};}});
  await store.ensure(snapshot,config);
  await assert.rejects(store.start(snapshot.id,config,{signal:generation.signal}),/abort/i);
  assert.equal((await store.read(snapshot.id)).questions.length,0);
  const grading=new AbortController();
  const next=await fixture(t,{grade:async()=>{grading.abort();return{verdict:'correct',feedback:'Correct.',followUp:null};}});
  await next.store.ensure(snapshot,next.config);await next.store.start(snapshot.id,next.config);
  await assert.rejects(next.store.answer(snapshot.id,'Yes.',next.config,{signal:grading.signal}),/abort/i);
  assert.equal(await next.store.approved(snapshot,next.config),false);
});

async function legacyQuestions(store, env, config, { index = 0, current = q } = {}) {
  const session = await store.ensure(snapshot, config);
  session.status = 'active';
  session.questions = [0, 1, 2].map(n => ({ ...q, id: `legacy-${n}`, prompt: `Stored scenario ${n}?` }));
  session.questions[index] = current;
  session.index = index;
  session.calls = 2; // The generation and a failed grading request already cost calls.
  await writeJson(sessionFile(snapshot.id, env), session);
}

test('legacy small checkpoints keep the current question and trim extras without regenerating or passing', async t => {
  const {store,env,config}=await fixture(t, {generate:async()=>{throw new Error('Must not regenerate');}});
  await legacyQuestions(store,env,config);
  const state=await store.start(snapshot.id,config);
  assert.deepEqual(state.progress,{completed:0,total:1});
  assert.deepEqual(state.question,{id:q.id,prompt:q.prompt,choices:q.choices});
  assert.equal(state.usage.calls,2);
  assert.equal(state.status,'active');
  assert.equal(await store.approved(snapshot,config),false);
  assert.equal((await store.read(snapshot.id)).questions.length,1);
  const completed=await store.answer(snapshot.id,'Yes, each request inserts.',config);
  assert.equal(completed.status,'passed');
  assert.equal(completed.usage.calls,3);
});

test('legacy migration retains completed work and a current transfer question, even beyond the new ceiling', async t => {
  const current={...q,id:'transfer',prompt:'After a timeout can a new attempt insert again? Explain why.'};
  const {store,env,config}=await fixture(t);
  await legacyQuestions(store,env,config,{index:1,current});
  const state=await store.start(snapshot.id,config);
  assert.deepEqual(state.progress,{completed:1,total:2});
  assert.equal(state.question.id,current.id);
  assert.equal(state.status,'active');
  assert.equal(await store.approved(snapshot,config),false);
  assert.equal((await store.answer(snapshot.id,'Yes, no key prevents a repeated insert.',config)).status,'passed');
});

test('an answer to an already-open legacy check uses the new ceiling and still requires correct grading', async t => {
  let grades=0;
  const current={...q,id:'transfer',prompt:'Does retrying after a lost response repeat the insert? Why?'};
  const {store,env,config}=await fixture(t,{grade:async()=>++grades===1
    ? {verdict:'incorrect',feedback:'Every attempt inserts.',followUp:current}
    : {verdict:'correct',feedback:'Yes, it inserts again.',followUp:null}});
  await legacyQuestions(store,env,config);
  const missed=await store.answer(snapshot.id,'No.',config);
  assert.equal(missed.status,'active');
  assert.deepEqual(missed.progress,{completed:0,total:1});
  assert.equal(missed.question.id,current.id);
  assert.equal((await store.answer(snapshot.id,'Yes, inserts are unconditional.',config)).status,'passed');
});

test('oversized new question sets fail without saving questions or approving the checkpoint', async t => {
  const {store,config}=await fixture(t,{generate:async()=>({questions:[q,{...q,id:'extra'}]})});
  await store.ensure(snapshot,config);
  await assert.rejects(store.start(snapshot.id,config),/exceeded the question limit/);
  const record=await store.read(snapshot.id);
  assert.equal(record.status,'pending');
  assert.equal(record.questions.length,0);
  assert.equal(record.calls,1);
  assert.equal(await store.approved(snapshot,config),false);
});

async function failedReview(store, env, config, calls = 9) {
  const session = await store.ensure(snapshot, config);
  session.calls = calls;
  session.preparation = { status: 'failed', completedAt: new Date().toISOString() };
  await writeJson(sessionFile(snapshot.id, env), session);
  return session;
}

test('ordinary review errors keep their recovery flow and reviewer exhaustion reuses the remaining allowance', async t => {
  const authError=new Error('Evaluator authentication is unavailable. Configure it and try again.');
  const first=await fixture(t,{generate:async()=>{throw authError;}});
  await first.store.ensure(snapshot,first.config);
  await assert.rejects(first.store.start(snapshot.id,first.config),error=>error===authError && !error.message.includes('--retry-review'));
  assert.equal((await first.store.read(snapshot.id)).calls,1);
  const exhausted=Object.assign(new Error('Review turn budget exhausted.'),{code:'REVIEWER_BUDGET'});
  const second=await fixture(t,{generate:async()=>{throw exhausted;}});
  await second.store.ensure(snapshot,second.config);
  await assert.rejects(second.store.start(snapshot.id,second.config),error=>error.code==='REVIEWER_BUDGET' && error.message.includes(`sphinx check --id ${snapshot.id}`) && !error.message.includes('--retry-review'));
  assert.equal((await second.store.read(snapshot.id)).callLimit,undefined);
});

test('typed provider failures reuse remaining allowance with exact recovery command and sanitized diagnostic fields', async t => {
  const providerError=Object.assign(new OpenRouterError('OpenRouter provider error (finish_reason: error).',{status:503,errorType:'server'}),{
    generationId:'gen-safe-test',
    cause:new Error('PRIVATE PROVIDER PAYLOAD'),
  });
  const {store,env,config}=await fixture(t,{generate:async(_s,_c,{beforeCall})=>{await beforeCall();await beforeCall();await beforeCall();throw providerError;}});
  config.maxModelCalls=10;
  await failedReview(store,env,config);await store.retryReview(snapshot.id,config);
  await assert.rejects(store.start(snapshot.id,config),error=>{
    assert.equal(error.name,'OpenRouterError');assert.equal(error.code,'OPENROUTER_PROVIDER_ERROR');assert.equal(error.status,503);
    assert.equal(error.errorType,'server');assert.equal(error.generationId,undefined);assert.equal(error.cause,undefined);
    assert.match(error.message,/7 model calls remain.*12\/19 used/);
    assert.ok(error.message.includes(`sphinx check --id ${snapshot.id}`));assert.doesNotMatch(error.message,/--retry-review|PRIVATE PROVIDER/);
    return true;
  });
  const record=await store.read(snapshot.id);
  assert.equal(record.calls,12);assert.equal(record.callLimit,19);assert.equal(record.reviewRetries.length,1);
  assert.equal(record.questions.length,0);assert.equal(record.preparation.status,'failed');assert.equal(await store.approved(snapshot,config),false);
});

test('typed provider failure offers extension only when the remaining budget cannot fit review and grading', async t => {
  const providerError=Object.assign(new OpenRouterError('Provider unavailable.',{status:503}),{generationId:'gen-safe-test'});
  const {store,config}=await fixture(t,{generate:async()=>{throw providerError;}});
  config.maxModelCalls=3;await store.ensure(snapshot,config);
  await assert.rejects(store.start(snapshot.id,config),error=>{
    assert.equal(error.code,'OPENROUTER_PROVIDER_ERROR');assert.equal(error.status,503);assert.equal(error.generationId,undefined);
    assert.ok(error.message.includes(`sphinx check --id ${snapshot.id} --retry-review`));
    assert.doesNotMatch(error.message,/retry within that allowance/);return true;
  });
  assert.equal((await store.read(snapshot.id)).calls,1);assert.equal((await store.read(snapshot.id)).callLimit,undefined);
});

test('explicit review retry retains prior usage, authorizes one fresh allowance, and performs no inference', async t => {
  let generations = 0, grades = 0;
  const {store,env,config}=await fixture(t, {
    generate:async()=>{generations++;return {questions:[q]};},
    grade:async()=>{grades++;return {verdict:'correct',feedback:'Correct.',followUp:null};},
  });
  config.maxModelCalls=10;
  await failedReview(store,env,config);
  const authorized=await store.retryReview(snapshot.id,config);
  assert.deepEqual(authorized.usage,{calls:9,limit:19});
  assert.equal(authorized.reviewAttempts,2);
  assert.equal(authorized.status,'pending');assert.equal(authorized.preparation.status,'pending');
  assert.equal(generations,0);assert.equal(grades,0);assert.equal(await store.approved(snapshot,config),false);
  const record=await store.read(snapshot.id);
  assert.equal(record.config.maxModelCalls,10);
  assert.deepEqual(record.reviewRetries,[{at:record.reviewRetries[0].at,calls:9,previousLimit:10,limit:19}]);
  assert.equal(Number.isFinite(Date.parse(record.reviewRetries[0].at)),true);
  await assert.rejects(store.retryReview(snapshot.id,config),/Only a failed review/);
  assert.equal((await store.start(snapshot.id,config)).usage.calls,10);
  const passed=await store.answer(snapshot.id,'Yes, every attempt inserts.',config);
  assert.deepEqual(passed.usage,{calls:11,limit:19});assert.equal(passed.status,'passed');
  assert.equal(generations,1);assert.equal(grades,1);
});

test('ordinary starts never reset or extend a failed review budget and explain the exact explicit recovery command', async t => {
  let generations=0;
  const {store,env,config}=await fixture(t,{generate:async()=>{generations++;return {questions:[q]};}});
  config.maxModelCalls=10;
  await failedReview(store,env,config);
  for (let attempt=0;attempt<2;attempt++) {
    await assert.rejects(store.start(snapshot.id,config),error=>error.message.includes(`sphinx check --id ${snapshot.id} --retry-review`) && /at least 2/.test(error.message));
  }
  const record=await store.read(snapshot.id);
  assert.equal(generations,0);assert.equal(record.calls,9);assert.equal(record.callLimit,undefined);assert.equal(record.reviewRetries,undefined);
  assert.deepEqual(store.public(record).usage,{calls:9,limit:10});
  assert.equal(record.preparation.status,'failed');assert.equal(await store.approved(snapshot,config),false);
});

test('fewer than two review calls fail before inference, and an inherently undersized fresh allowance is refused', async t => {
  let generations=0;
  const {store,config}=await fixture(t,{generate:async()=>{generations++;return {questions:[q]};}});
  config.maxModelCalls=2;
  await store.ensure(snapshot,config);
  await assert.rejects(store.prepare(snapshot.id,config),/at least 2.*reserved grading.*No model request.*--retry-review/);
  assert.equal(generations,0);assert.equal((await store.read(snapshot.id)).calls,0);
  await assert.rejects(store.retryReview(snapshot.id,config),/configured allowance of 2 cannot fit/);
  assert.equal((await store.read(snapshot.id)).reviewRetries,undefined);
});

test('explicit recovery validates unchanged policy and snapshot before changing any counters', async t => {
  let stale=false;
  const {store,env,config}=await fixture(t,{validate:async()=>{if(stale)throw new Error('Snapshot changed');}});
  await failedReview(store,env,config);
  const before=await store.read(snapshot.id);
  await assert.rejects(store.retryReview(snapshot.id,{...config,level:'thorough'}),/settings changed/);
  assert.deepEqual(await store.read(snapshot.id),before);
  stale=true;
  await assert.rejects(store.retryReview(snapshot.id,config),/Snapshot changed/);
  assert.deepEqual(await store.read(snapshot.id),before);
});

test('unstarted reviews, active questions, grading failures, and passed receipts cannot be restarted', async t => {
  let failGrade=true;
  const {store,config}=await fixture(t,{grade:async()=>{if(failGrade)throw new Error('Grading unavailable');return {verdict:'correct',feedback:'Correct.',followUp:null};}});
  await store.ensure(snapshot,config);
  await assert.rejects(store.retryReview(snapshot.id,config),/Only a failed review/);
  await store.start(snapshot.id,config);
  await assert.rejects(store.retryReview(snapshot.id,config),/Only a failed review/);
  await assert.rejects(store.answer(snapshot.id,'Yes.',config),/Grading unavailable/);
  await assert.rejects(store.retryReview(snapshot.id,config),/Only a failed review/);
  assert.equal((await store.read(snapshot.id)).calls,2);
  assert.equal((await store.read(snapshot.id)).questions[0].id,q.id);
  failGrade=false;await store.answer(snapshot.id,'Yes.',config);
  await assert.rejects(store.retryReview(snapshot.id,config),/Only a failed review/);
  assert.equal(await store.approved(snapshot,config),true);
  assert.equal((await store.read(snapshot.id)).reviewRetries,undefined);
});

test('review retries share the session lock and cannot double-authorize concurrent requests', async t => {
  let hold=false, entered, release;
  const ready=new Promise(resolve=>{entered=resolve;}), pause=new Promise(resolve=>{release=resolve;});
  const {store,env,config}=await fixture(t,{validate:async()=>{if(hold){entered();await pause;}}});
  config.maxModelCalls=10;
  await failedReview(store,env,config);
  hold=true;
  const first=store.retryReview(snapshot.id,config);await ready;
  await assert.rejects(store.retryReview(snapshot.id,config),/already running/);
  release();await first;
  const record=await store.read(snapshot.id);
  assert.equal(record.reviewRetries.length,1);assert.equal(record.calls,9);assert.equal(record.callLimit,19);
});

test('grading observes the extended cumulative limit and a later failure never silently extends it again', async t => {
  const {store,env,config}=await fixture(t,{grade:async()=>({verdict:'ambiguous',feedback:'Unclear; no receipt.',followUp:null})});
  config.maxModelCalls=3;
  await failedReview(store,env,config,2);
  await store.retryReview(snapshot.id,config);
  assert.deepEqual((await store.start(snapshot.id,config)).usage,{calls:3,limit:5});
  await store.answer(snapshot.id,'Maybe.',config);await store.answer(snapshot.id,'Maybe again.',config);
  await assert.rejects(store.answer(snapshot.id,'Still maybe.',config),/call limit \(5\)/);
  await assert.rejects(store.retryReview(snapshot.id,config),/Only a failed review/);
  const record=await store.read(snapshot.id);
  assert.equal(record.calls,5);assert.equal(record.callLimit,5);assert.equal(record.reviewRetries.length,1);
  assert.equal(await store.approved(snapshot,config),false);
});

test('transport-reported tokens and cost accumulate on the checkpoint and reach the public state', async t => {
  const { reportUsage } = await import('../src/usage.js');
  const { store, config } = await fixture(t, {
    generate: async (_snapshot, _config, { beforeCall }) => {
      await beforeCall(); reportUsage({ inputTokens: 1000, outputTokens: 200, cost: 0.002 });
      await beforeCall(); reportUsage({ inputTokens: 500, outputTokens: 100, cost: 0.001 });
      return { questions: [q], review: { version: 1, summary: 'Reviewed.', evidence: 'insert()', evidencePaths: ['src/order.js'], toolCalls: 1, compactions: 0 } };
    },
  });
  await store.ensure(snapshot, config);
  const state = await store.start(snapshot.id, config);
  assert.deepEqual({ input: state.tokens.input, output: state.tokens.output }, { input: 1500, output: 300 });
  assert.ok(Math.abs(state.tokens.cost - 0.003) < 1e-9);
  assert.deepEqual(Object.keys(state.usage).sort(), ['calls', 'limit'], 'usage keeps its call-count shape');
});

test('reviewer and grading calls are tagged with their purpose in the usage ledger', async t => {
  const { reportUsage, withUsageLedger, readUsage } = await import('../src/usage.js');
  const { store, env, config } = await fixture(t, {
    generate: async () => { reportUsage({ inputTokens: 10, outputTokens: 2, provider: 'openrouter', model: 'openrouter/free' }); return { questions: [structuredClone(q)] }; },
    grade: async () => { reportUsage({ inputTokens: 5, outputTokens: 1, provider: 'claude', model: 'haiku' }); return { verdict: 'correct', feedback: 'Correct: the repeated insert can duplicate it.', followUp: null }; },
  });
  await withUsageLedger(env, async () => {
    await store.ensure(snapshot, config); await store.start(snapshot.id, config);
    await store.answer(snapshot.id, 'Yes: it inserts every time.', config);
  });
  assert.deepEqual(readUsage({ env }).map(entry => [entry.purpose, entry.tier]), [['review', 'free'], ['grading', 'plan']]);
});

test('a documentation-only change passes with no model call, before any page opens', async t => {
  let calls = 0;
  const { store, config } = await fixture(t, { generate: async () => { calls++; return { questions: [q] }; } });
  const docs = { ...snapshot, id: 'd'.repeat(64), files: ['README.md', 'docs/guide.mdx', 'LICENSE'] };
  await store.ensure(docs, config);
  assert.equal(await store.passTrivial(docs.id, config), true);
  const state = store.public(await store.read(docs.id));
  assert.equal(state.status, 'passed');
  assert.equal(state.noQuestionReason, 'Documentation-only change.');
  assert.equal(await store.approved(docs, config), true);
  assert.equal(calls, 0);
  const mixed = { ...snapshot, id: 'e'.repeat(64), files: ['README.md', 'src/order.js'] };
  await store.ensure(mixed, config);
  assert.equal(await store.passTrivial(mixed.id, config), false, 'Any code file needs a real check');
});

test('a small change the reviewer finds trivial passes with its reason; a larger one never passes with zero questions', async t => {
  const review = { version: 1, summary: 'Renamed a local variable.', evidence: 'x', evidencePaths: ['src/order.js'], toolCalls: 1, compactions: 0 };
  const small = await fixture(t, { generate: async (_s, _c, { beforeCall }) => { await beforeCall(); return { questions: [], noQuestionReason: 'Only renames a local variable; behavior is unchanged.', review }; } });
  await small.store.ensure(snapshot, small.config);
  const passed = await small.store.start(snapshot.id, small.config);
  assert.equal(passed.status, 'passed');
  assert.match(passed.noQuestionReason, /renames a local variable/);
  const big = { ...snapshot, id: 'f'.repeat(64), stats: { additions: 900, deletions: 300, files: 30 } };
  const large = await fixture(t, { generate: async (_s, _c, { beforeCall }) => { await beforeCall(); return { questions: [], noQuestionReason: 'Looks fine.', review }; } });
  await large.store.ensure(big, large.config);
  await assert.rejects(large.store.start(big.id, large.config), /no grounded questions/);
  assert.notEqual((await large.store.read(big.id)).status, 'passed');
  // With stated preferences, a larger change entirely in a skipped area may pass.
  const styled = { ...big, id: 'e'.repeat(64), projectContext: { path: '.sphinxcontext.md', text: '', preferences: "- Don't ask me about styling.", hash: 'p' } };
  const skipped = await fixture(t, { generate: async (_s, _c, { beforeCall }) => { await beforeCall(); return { questions: [], noQuestionReason: 'Only CSS changes, which your preferences skip.', review }; } });
  await skipped.store.ensure(styled, skipped.config);
  assert.equal((await skipped.store.start(styled.id, skipped.config)).status, 'passed');
});

test('each question is scored once: first-try correct, a miss after a wrong answer or explanation, never for a dispute', async t => {
  const { readStats } = await import('../src/stats.js');
  const follow = { ...q, id: 'follow', prompt: 'After a restart, can the same request run again? Why?' };
  const verdicts = ['incorrect', 'correct'];
  const { store, config, env } = await fixture(t, {
    generate: async (_s, _c, { beforeCall }) => { await beforeCall(); return { questions: [q, { ...q, id: 'second', prompt: 'Does a second worker share the guard? Why?' }], review: { version: 1, summary: 's', evidence: 'x', evidencePaths: ['src/order.js'], toolCalls: 1, compactions: 0 } }; },
    grade: async request => { await request.beforeCall(); const verdict = request.dispute ? 'ambiguous' : verdicts.shift() ?? 'correct'; return { verdict, feedback: verdict === 'correct' ? '' : 'No.', followUp: verdict === 'incorrect' ? follow : null }; },
  });
  const medium = { ...snapshot, id: '9'.repeat(64), stats: { additions: 200, deletions: 40, files: 6 } };
  await store.ensure(medium, config);
  await store.start(medium.id, config);
  await store.answer(medium.id, 'It is ambiguous.', config, { dispute: true });
  await store.answer(medium.id, 'Wrong idea.', config);
  await store.answer(medium.id, 'Right idea.', config);
  await store.answer(medium.id, 'Right again.', config);
  const stats = await readStats(medium.repoRoot, env);
  assert.deepEqual([stats.answered, stats.firstTry, stats.completed], [2, 1, 1], 'Question 1 missed then recovered counts once as a miss; question 2 first-try');
});

test('a documentation check never blocks on a check that background preparation is holding', async t => {
  const { store, config } = await fixture(t);
  await store.ensure(snapshot, config);
  assert.equal(await store.passTrivial(snapshot.id, config, snapshot), false, 'Code changes are decided without taking the lock');
});
test('a failed grade keeps the answer or dispute text for the same question until a grade is saved', async t => {
  let attempt=0;
  const {store,config}=await fixture(t,{grade:async()=>{
    if(++attempt<=2) throw new OpenRouterError('OpenRouter HTTP 429 (code: 429). Provider or account rate limit reached.', {status:429});
    return {verdict:'correct',feedback:'Correct.',followUp:null};
  }});
  await store.ensure(snapshot,config); await store.start(snapshot.id,config);
  await assert.rejects(store.answer(snapshot.id,'  Yes: it inserts every time.  ',config), error => {
    assert.equal(error.code,'OPENROUTER_PROVIDER_ERROR'); assert.equal(error.status,429);
    assert.match(error.message,/Your answer was saved and is offered again when you resume this question/);
    return true;
  });
  let saved=await store.read(snapshot.id);
  assert.deepEqual(savedDraft(saved),{kind:'answer',text:'Yes: it inserts every time.'});
  assert.equal(JSON.stringify(store.public(saved)).includes('inserts every time'),false,'The draft stays out of agent-visible state');
  await assert.rejects(store.answer(snapshot.id,'The question assumes no unique index.',config,{dispute:true}), /Your dispute reason was saved/);
  assert.deepEqual(savedDraft(await store.read(snapshot.id)),{kind:'dispute',text:'The question assumes no unique index.'});
  assert.equal((await store.answer(snapshot.id,'Yes: it inserts every time.',config)).status,'passed');
  saved=await store.read(snapshot.id);
  assert.equal(saved.draft,undefined); assert.equal(savedDraft(saved),null);
});

test('a saved draft is not offered for a different question', () => {
  const session={status:'active',index:0,questions:[{id:'next'}],draft:{questionId:'retry',kind:'answer',text:'Old.'}};
  assert.equal(savedDraft(session),null);
  assert.deepEqual(savedDraft({...session,questions:[{id:'retry'}]}),{kind:'answer',text:'Old.'});
});

test('a wrong answer or an explanation without a follow-up keeps the same question, records each attempt, and scores one miss', async t => {
  const { readStats } = await import('../src/stats.js');
  const grades = [{ verdict: 'incorrect', feedback: 'Nothing deduplicates the insert.' }, { verdict: 'incorrect', feedback: 'Here is how it works.' }, { verdict: 'correct', feedback: '' }];
  const { store, config, env } = await fixture(t, { grade: async () => ({ ...grades.shift(), followUp: null }) });
  await store.ensure(snapshot, config); await store.start(snapshot.id, config);
  const missed = await store.answer(snapshot.id, 'No.', config, { expectedQuestionId: q.id });
  assert.deepEqual([missed.status, missed.verdict, missed.question.id, missed.feedback], ['active', 'incorrect', q.id, 'Nothing deduplicates the insert.']);
  const explained = await store.answer(snapshot.id, 'Teach me.', config, { learn: true, expectedQuestionId: q.id });
  assert.deepEqual([explained.question.id, explained.feedback], [q.id, 'Here is how it works.']);
  assert.equal((await store.answer(snapshot.id, 'Yes: it inserts every time.', config, { expectedQuestionId: q.id })).status, 'passed');
  const saved = await store.read(snapshot.id);
  assert.deepEqual(saved.attempts.map(item => [item.kind, item.verdict, item.questionId]), [['answer', 'incorrect', q.id], ['learn', 'incorrect', q.id], ['answer', 'correct', q.id]]);
  const stats = await readStats(snapshot.repoRoot, env);
  assert.deepEqual([stats.answered, stats.firstTry], [1, 0]);
});

test('a grader reply Sphinx cannot use is explained in plain words with the original text on detail; other failures are unchanged', async t => {
  const plain = { answer: 'The grader\'s reply couldn\'t be used, so this wasn\'t graded. Your text is saved; sending it again makes another model call.', learn: 'The grader\'s reply couldn\'t be used, so no explanation is shown. Asking again makes another model call.' };
  for (const code of ['INVALID_MODEL_OUTPUT', 'INSUFFICIENT_EVIDENCE', 'INVALID_REVIEW_ACTION']) {
    const failure = Object.assign(new Error(`Return one complete JSON object (${code}). Retry the assessment.`), { code });
    const { store, config } = await fixture(t, { grade: async () => { throw failure; } });
    await store.ensure(snapshot, config); await store.start(snapshot.id, config);
    for (const [options, message] of [[{}, plain.answer], [{ dispute: true }, plain.answer], [{ learn: true }, plain.learn]]) {
      await assert.rejects(store.answer(snapshot.id, 'Yes: it inserts every time.', config, options), error => {
        assert.deepEqual([error.message, error.detail, error.code], [message, failure.message, code], JSON.stringify(options));
        return true;
      });
    }
    const saved = await store.read(snapshot.id);
    assert.deepEqual(savedDraft(saved), { kind: 'dispute', text: 'Yes: it inserts every time.' });
    assert.deepEqual([saved.attempts.length, saved.index, saved.status], [0, 0, 'active']);
  }
  const outage = Object.assign(new Error('Provider unavailable.'), { code: 'OPENROUTER_PROVIDER_ERROR' });
  const { store, config } = await fixture(t, { grade: async () => { throw outage; } });
  await store.ensure(snapshot, config); await store.start(snapshot.id, config);
  await assert.rejects(store.answer(snapshot.id, 'Teach me.', config, { learn: true }), error => error === outage);
  await assert.rejects(store.answer(snapshot.id, 'Yes.', config), error => error.message === 'Provider unavailable. Your answer was saved and is offered again when you resume this question.' && error.detail === undefined);
});

test('a renamed replacement id skips every id the check has used and stays within 80 characters', async t => {
  const later = { ...q, id: 'x'.repeat(80), prompt: 'Does a second worker share the guard? Why?' };
  // The next question's id twice, then the id of the question the first replacement took over.
  const proposed = [later.id, later.id, q.id];
  const graded = [];
  const { store, config } = await fixture(t, {
    generate: async () => ({ questions: [q, later] }),
    grade: async request => {
      graded.push(request.question.id);
      const id = proposed.shift();
      return id ? { verdict: 'incorrect', feedback: 'No.', followUp: { ...q, id, prompt: `Scenario ${graded.length}: after a restart, can the request run again? Why?` } } : { verdict: 'correct', feedback: '', followUp: null };
    },
  });
  const medium = { ...snapshot, id: '8'.repeat(64), stats: { additions: 200, deletions: 40, files: 6 } };
  await store.ensure(medium, config); await store.start(medium.id, config);
  const shown = [q.id];
  for (let miss = 0; miss < 3; miss++) shown.push((await store.answer(medium.id, 'No.', config, { expectedQuestionId: shown.at(-1) })).question.id);
  assert.deepEqual(shown, [q.id, `${'x'.repeat(70)}-2`, `${'x'.repeat(70)}-3`, `${q.id}-2`]);
  for (const old of shown.slice(0, -1)) await assert.rejects(store.answer(medium.id, 'A late answer.', config, { expectedQuestionId: old }), { code: 'SPHINX_STALE_QUESTION' }, old);
  assert.equal(graded.length, 3, 'A stale answer is never graded');
});
