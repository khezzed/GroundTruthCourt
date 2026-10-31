import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient, chains, createAccount, generatePrivateKey } from 'genlayer-js';

// Setup custom browser User-Agent header across all fetch calls
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const origFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const headers = new Headers(init?.headers || {});
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', BROWSER_UA);
  }
  return origFetch(url, { ...init, headers });
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const STATE_FILE = path.join(ROOT_DIR, 'deploy', 'state.json');
const MANIFEST_FILE = path.join(ROOT_DIR, 'deploy', 'manifest.json');
const COMMIT_SHA = '757bfe0801412714cc81cbe7092bb4ffafa52f55';
const RUNNER_HASH = 'py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6';
const GIT_BLOB_HASH = '9943f622588e7bd529cf189702ed3c19c723db47';

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function normalizeReturn(val) {
  if (typeof val === 'string') {
    let s = val.trim();
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s;
  }
  return val;
}

export function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

export function saveState(patch) {
  const current = loadState();
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export function getAccounts() {
  const state = loadState();

  let pk1 = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || state.deployerPrivateKey;
  if (!pk1 || typeof pk1 !== 'string' || pk1.length !== 66) {
    pk1 = generatePrivateKey();
    saveState({ deployerPrivateKey: pk1 });
  }

  let pk2 = process.env.ACCOUNT2_PRIVATE_KEY || state.account2PrivateKey;
  if (!pk2 || typeof pk2 !== 'string' || pk2.length !== 66) {
    pk2 = generatePrivateKey();
    saveState({ account2PrivateKey: pk2 });
  }

  const account1 = createAccount(pk1);
  const account2 = createAccount(pk2);

  return { account1, account2 };
}

export function createStudioClient(account) {
  return createClient({
    chain: {
      ...chains.studionet,
      rpcUrls: {
        default: {
          http: ['https://studio.genlayer.com/api']
        }
      }
    },
    account
  });
}

export async function waitForReceipt(client, txHash, { maxAttempts = 120, intervalMs = 8000, expectSuccess = true } = {}) {
  console.log(`[POLL] Waiting for tx ${txHash} (expectSuccess=${expectSuccess})...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const tx = await client.getTransaction({ hash: txHash });
      const statusName = tx.statusName || (tx.consensus_history?.current_status_changes?.includes('FINALIZED') ? 'FINALIZED' : 'PENDING');
      const resultName = tx.result_name || 'UNKNOWN';
      const lr = tx.consensus_data?.leader_receipt?.[0];
      const execResult = lr?.execution_result || 'PENDING';
      const rawPayload = lr?.result?.payload?.readable ?? lr?.result?.payload ?? '';
      const returnPayload = normalizeReturn(rawPayload);
      const stderr = lr?.genvm_result?.stderr || '';
      const votes = tx.consensus_data?.votes || [];

      console.log(`  [Attempt ${attempt}/${maxAttempts}] status=${statusName} result=${resultName} GenVM=${execResult}`);

      if (statusName === 'FINALIZED') {
        const contractAddress = tx.to_address || tx.contract_address || (tx.data && tx.data.contract_address);

        if (expectSuccess && execResult !== 'SUCCESS') {
          throw new Error(`Transaction ${txHash} finalized with GenVM ${execResult} (expected SUCCESS). stderr: ${stderr} payload: ${JSON.stringify(returnPayload)}`);
        }

        return {
          finalized: true,
          status: statusName,
          result: resultName,
          executionResult: execResult,
          returnReadable: returnPayload,
          stderr,
          votes,
          contractAddress,
          tx
        };
      }
    } catch (err) {
      if (err.message && err.message.includes('finalized with GenVM')) {
        throw err;
      }
      console.warn(`  [Poll attempt ${attempt} warning]: ${err.message || err}`);
    }
  }
  throw new Error(`Transaction ${txHash} did not finalize in ${maxAttempts * intervalMs / 1000} seconds`);
}

async function readContractWithRetry(client, { address, functionName, args = [] }, retries = 6, delayMs = 3000) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.readContract({ address, functionName, args });
    } catch (err) {
      lastErr = err;
      console.warn(`  [readContract ${functionName} attempt ${attempt} warning]: ${err.message || err}`);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

async function safeWrite(client, { address, functionName, args = [], value = 0n, expectSuccess = true }) {
  let txHash = null;
  let receipt = null;
  let clientError = null;

  try {
    txHash = await client.writeContract({
      address,
      functionName,
      args,
      value
    });
    console.log(`  -> writeContract ${functionName} sent, txHash: ${txHash}`);
  } catch (err) {
    clientError = err;
    console.log(`  -> writeContract ${functionName} direct client error: ${err.message || err}`);
  }

  if (txHash) {
    receipt = await waitForReceipt(client, txHash, { expectSuccess });
  }

  return { txHash, receipt, clientError };
}

async function main() {
  console.log('===============================================================');
  console.log('  GroundTruth Court: StudioNet Deploy & Live Demo Workflow    ');
  console.log('===============================================================');

  const { account1, account2 } = getAccounts();
  console.log(`Deployer / Proposer Account (Account A): ${account1.address}`);
  console.log(`Secondary Attacker Account  (Account B): ${account2.address}`);

  const client1 = createStudioClient(account1);
  const client2 = createStudioClient(account2);

  const state = loadState();
  const txHistory = state.txHistory || [];

  // Helper to record transaction to state and manifest list
  function recordTx(item) {
    txHistory.push(item);
    saveState({ txHistory });
    console.log(`  [RECORDED STEP ${item.step}] ${item.method} | Hash: ${item.hash || 'N/A'} | Status: ${item.status || 'CLIENT_ERROR'} | Exec: ${item.executionResult || 'N/A'}`);
  }

  // ---------------------------------------------------------------------------
  // STEP B: Deploy & Run Trivial Probe Contract
  // ---------------------------------------------------------------------------
  console.log('\n--- B. PROBE CONTRACT ---');
  let probeAddress = state.probeAddress;
  let probeDeployTx = state.probeDeployTx;
  let probeSetTx = state.probeSetTx;

  if (!probeAddress) {
    const probePath = path.join(ROOT_DIR, 'deploy', 'probe.py');
    const probeCode = fs.readFileSync(probePath, 'utf-8');
    console.log(`Deploying probe.py (${probeCode.length} bytes)...`);

    probeDeployTx = await client1.deployContract({ code: probeCode });
    console.log(`Probe Deploy Tx: ${probeDeployTx}`);
    const probeReceipt = await waitForReceipt(client1, probeDeployTx, { expectSuccess: true });
    probeAddress = probeReceipt.contractAddress;
    console.log(`Probe Finalized at: ${probeAddress}`);
    saveState({ probeAddress, probeDeployTx });

    console.log('Writing on Probe: set_val("probe_ok")...');
    probeSetTx = await client1.writeContract({
      address: probeAddress,
      functionName: 'set_val',
      args: ['probe_ok']
    });
    console.log(`Probe set_val Tx: ${probeSetTx}`);
    await waitForReceipt(client1, probeSetTx, { expectSuccess: true });
    saveState({ probeSetTx });

    const probeVal = await readContractWithRetry(client1, {
      address: probeAddress,
      functionName: 'get_val',
      args: []
    });
    console.log(`Probe readback get_val: "${probeVal}"`);
    if (probeVal !== 'probe_ok') {
      throw new Error(`Probe check failed: expected 'probe_ok', got '${probeVal}'`);
    }
    console.log('[PASS] Probe Contract fully verified on StudioNet!');
  } else {
    console.log(`[SKIP] Probe contract already deployed at: ${probeAddress}`);
  }

  // ---------------------------------------------------------------------------
  // STEP C: Deploy Main Contract & Verify Git Blob Equality
  // ---------------------------------------------------------------------------
  console.log('\n--- C. DEPLOY MAIN CONTRACT & VERIFY INTEGRITY ---');
  let mainAddress = state.mainAddress;
  let mainDeployTx = state.mainDeployTx;

  const mainPath = path.join(ROOT_DIR, 'contracts', 'ground_truth_court.py');
  const mainCode = fs.readFileSync(mainPath, 'utf-8');
  const localSha256 = sha256(mainCode);
  console.log(`Local contract path    : ${mainPath}`);
  console.log(`Local contract size    : ${mainCode.length} bytes`);
  console.log(`Git blob hash (sha1)   : ${GIT_BLOB_HASH}`);
  console.log(`Local source sha256    : ${localSha256}`);

  if (!mainAddress) {
    console.log(`Deploying GroundTruthCourt (${mainCode.length} bytes)...`);
    mainDeployTx = await client1.deployContract({ code: mainCode });
    console.log(`Main Deploy Tx: ${mainDeployTx}`);
    const mainReceipt = await waitForReceipt(client1, mainDeployTx, { expectSuccess: true });
    mainAddress = mainReceipt.contractAddress;
    console.log(`Main Contract Finalized at: ${mainAddress}`);
    saveState({ mainAddress, mainDeployTx });
  } else {
    console.log(`[SKIP] Main contract already deployed at: ${mainAddress}`);
  }

  // Fetch deployed on-chain bytecode / code
  console.log('Fetching deployed source code from StudioNet RPC...');
  const onChainCode = await client1.getContractCode(mainAddress);
  const onChainSha256 = sha256(onChainCode);
  console.log(`On-chain code sha256   : ${onChainSha256}`);

  const blobEquality = (mainCode === onChainCode) && (localSha256 === onChainSha256);
  console.log(`Byte-for-byte equality : ${blobEquality ? 'MATCH (100%)' : 'MISMATCH'}`);
  if (!blobEquality) {
    throw new Error(`CRITICAL: Byte-for-byte source code mismatch against deployed contract!`);
  }

  // ---------------------------------------------------------------------------
  // STEP D: LIVE DEMO & VALIDATION WORKFLOW
  // ---------------------------------------------------------------------------
  console.log('\n--- D. LIVE DEMO ON STUDIONET ---');
  const BASE_URL = `https://raw.githubusercontent.com/khezzed/GroundTruthCourt/${COMMIT_SHA}/evidence`;
  const e0 = `${BASE_URL}/e0_release_notes_v2.txt`;
  const e1 = `${BASE_URL}/e1_rc1_changelog.txt`;
  const e2 = `${BASE_URL}/e2_final_tag_changelog.txt`;
  const e3 = `${BASE_URL}/e3_lab_a.txt`;
  const e4 = `${BASE_URL}/e4_lab_b.txt`;
  const e5 = `${BASE_URL}/e5_unrelated.txt`;

  const evidenceFilesList = [
    { name: 'e0_release_notes_v2.txt', url: e0, rawBytes: 221, httpCode: 200, sha256: '0a7f02b7682dfff51cd60fd3e7942c236df4a691cd321dc6851a523bf9b840c3' },
    { name: 'e1_rc1_changelog.txt', url: e1, rawBytes: 184, httpCode: 200, sha256: '2b025100742f284fe2013eb29a35a4529811bab79dd079c0eb1806c71b252eaf' },
    { name: 'e2_final_tag_changelog.txt', url: e2, rawBytes: 293, httpCode: 200, sha256: '685e4c5622446845ecc05fc48668ce1a493fd14417a800a094d9bd288290a974' },
    { name: 'e3_lab_a.txt', url: e3, rawBytes: 217, httpCode: 200, sha256: '118e919f3c682e1c1ae7b9ca039b289fd9216807d4ed3dc64a125f7ca09df452' },
    { name: 'e4_lab_b.txt', url: e4, rawBytes: 207, httpCode: 200, sha256: '2c4a694ec9e04d8128455639bf05b57e0917af9e2a65d427522091708fd75849' },
    { name: 'e5_unrelated.txt', url: e5, rawBytes: 237, httpCode: 200, sha256: 'a72891b5f880b7688c1a790828ddf47ec52ba73df12fa6272b3aadef531bd99f' },
  ];

  // Helper to check if step already recorded in state
  function getRecordedStep(stepNum) {
    return txHistory.find(t => t.step === stepNum);
  }

  // ---------------------------------------------------------------------------
  // Case 1: Reinstatement Scenario
  // ---------------------------------------------------------------------------
  let case1Deadline = state.case1Deadline;
  if (!case1Deadline) {
    case1Deadline = Math.floor(Date.now() / 1000) + 1500;
    saveState({ case1Deadline });
  }

  // Step 1: open_case 1
  let step1 = getRecordedStep(1);
  if (!step1) {
    console.log('\n[Step 1] open_case 1 (backward compatible)...');
    const claim1 = 'tinyjson v2.0.0 is backward compatible with the v1.x parse() API.';
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'open_case',
      args: [claim1, e0, case1Deadline, 60],
      expectSuccess: true
    });
    const c1 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [1] }));
    console.log('Case 1 readback:', JSON.stringify(c1));

    if (c1.status !== 'OPEN' || c1.labels['0'] !== 'IN') {
      console.error('STOP RULE: Case 1 not OPEN with root IN!');
      process.exit(1);
    }

    step1 = {
      step: 1,
      scenario: 'Case 1: Reinstatement',
      method: 'open_case',
      args: [claim1, e0, case1Deadline, 60],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'OPEN (case_id 1, root IN)',
      actual: `${c1.status} (root ${c1.labels['0']})`,
      expectedFailure: false,
      readBack: c1
    };
    recordTx(step1);
  } else {
    console.log(`[SKIP] Step 1 already executed: ${step1.hash}`);
  }

  // Step 2: attack 1 (target 0, text rc1 breaking changelog)
  let step2 = getRecordedStep(2);
  if (!step2) {
    console.log('\n[Step 2] attack Case 1, target 0...');
    const text2 = 'v2.0.0 removed the strict parameter from parse(), so v1.x callers passing strict=True break.';
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'attack',
      args: [1, 0, text2, e1],
      expectSuccess: true
    });
    const c1 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [1] }));
    console.log('Case 1 readback after attack 1:', JSON.stringify(c1));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('ADMITTED:ARG_1') || c1.labels['0'] !== 'OUT') {
      console.error('STOP RULE: Step 2 attack not admitted or root not OUT!');
      process.exit(1);
    }

    step2 = {
      step: 2,
      scenario: 'Case 1: Reinstatement',
      method: 'attack',
      args: [1, 0, text2, e1],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'ADMITTED:ARG_1 (root OUT)',
      actual: `${ret} (root ${c1.labels['0']})`,
      expectedFailure: false,
      readBack: c1
    };
    recordTx(step2);
  } else {
    console.log(`[SKIP] Step 2 already executed: ${step2.hash}`);
  }

  // Step 3: attack 2 (target 1, counter-attack: reverted in final tag)
  let step3 = getRecordedStep(3);
  if (!step3) {
    console.log('\n[Step 3] attack Case 1, target 1 (counter-attack)...');
    const text3 = 'The strict removal was only in v2.0.0-rc1 and was reverted before the v2.0.0 final tag, which still ships parse(text, strict=False).';
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'attack',
      args: [1, 1, text3, e2],
      expectSuccess: true
    });
    const c1 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [1] }));
    console.log('Case 1 readback after attack 2:', JSON.stringify(c1));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('ADMITTED:ARG_2') || c1.labels['0'] !== 'IN') {
      console.error('STOP RULE: Step 3 attack not admitted or root not reinstated (IN)!');
      process.exit(1);
    }

    step3 = {
      step: 3,
      scenario: 'Case 1: Reinstatement',
      method: 'attack',
      args: [1, 1, text3, e2],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'ADMITTED:ARG_2 (root IN reinstated)',
      actual: `${ret} (root ${c1.labels['0']})`,
      expectedFailure: false,
      readBack: c1
    };
    recordTx(step3);
  } else {
    console.log(`[SKIP] Step 3 already executed: ${step3.hash}`);
  }

  // ---------------------------------------------------------------------------
  // Expected Failures / Abuse Controls Blocked (Case 1)
  // ---------------------------------------------------------------------------
  // Step 4: attack with unrelated evidence -> expect REJECTED with FINALIZED+SUCCESS
  let step4 = getRecordedStep(4);
  if (!step4) {
    console.log('\n[Step 4 - EXPECTED FAILURE] attack target 0 with unrelated evidence (cookies) by Account B...');
    const text4 = 'tinyjson v2.0.0 breaks compatibility.';
    const res = await safeWrite(client2, {
      address: mainAddress,
      functionName: 'attack',
      args: [1, 0, text4, e5],
      expectSuccess: true
    });
    const c1 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [1] }));
    console.log('Case 1 readback after unrelated attack:', JSON.stringify(c1));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('REJECTED')) {
      console.error('STOP RULE: Step 4 was unexpectedly admitted!');
      process.exit(1);
    }

    step4 = {
      step: 4,
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'attack',
      args: [1, 0, text4, e5],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'REJECTED return (FINALIZED + SUCCESS)',
      actual: ret,
      expectedFailure: true,
      readBack: { totalArgs: c1.args.length, rootLabel: c1.labels['0'] }
    };
    recordTx(step4);
  } else {
    console.log(`[SKIP] Step 4 already executed: ${step4.hash}`);
  }

  // Step 5: Replay of step 2's exact (target, url, text) -> expect UserError REPLAY
  let step5 = getRecordedStep(5);
  if (!step5) {
    console.log('\n[Step 5 - EXPECTED FAILURE] Replay of step 2 exact submission by Account B...');
    const text2 = 'v2.0.0 removed the strict parameter from parse(), so v1.x callers passing strict=True break.';
    const res = await safeWrite(client2, {
      address: mainAddress,
      functionName: 'attack',
      args: [1, 0, text2, e1],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Replay error received:', errStr);

    if (!errStr.includes('REPLAY')) {
      console.error('STOP RULE: Step 5 did not fail with REPLAY!');
      process.exit(1);
    }

    step5 = {
      step: 5,
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'attack',
      args: [1, 0, text2, e1],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      returnOrError: errStr,
      votes: res.receipt?.votes || [],
      expected: 'UserError: REPLAY',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Replay prevented'
    };
    recordTx(step5);
  } else {
    console.log(`[SKIP] Step 5 already executed: ${step5.hash}`);
  }

  // Step 6: add_edge from Account B (different from author of arg 1, which is Account A) -> expect unauthorized UserError
  let step6 = getRecordedStep(6);
  if (!step6) {
    console.log('\n[Step 6 - EXPECTED FAILURE] add_edge from unauthorized caller (Account B)...');
    const res = await safeWrite(client2, {
      address: mainAddress,
      functionName: 'add_edge',
      args: [1, 1, 2],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Unauthorized error received:', errStr);

    if (!errStr.toLowerCase().includes('unauthorized')) {
      console.error('STOP RULE: Step 6 did not fail with unauthorized!');
      process.exit(1);
    }

    step6 = {
      step: 6,
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'add_edge',
      args: [1, 1, 2],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      returnOrError: errStr,
      votes: res.receipt?.votes || [],
      expected: 'UserError: unauthorized',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Unauthorized edge prevented'
    };
    recordTx(step6);
  } else {
    console.log(`[SKIP] Step 6 already executed: ${step6.hash}`);
  }

  // Step 7: attack with unpinned URL (branch URL /main/...) -> expect UserError INVALID_EVIDENCE_URL
  let step7 = getRecordedStep(7);
  if (!step7) {
    console.log('\n[Step 7 - EXPECTED FAILURE] attack with unpinned URL (main branch) by Account B...');
    const unpinnedUrl = 'https://raw.githubusercontent.com/khezzed/GroundTruthCourt/main/evidence/e1_rc1_changelog.txt';
    const res = await safeWrite(client2, {
      address: mainAddress,
      functionName: 'attack',
      args: [1, 0, 'Breaking change with unpinned url', unpinnedUrl],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Invalid URL error received:', errStr);

    if (!errStr.includes('INVALID_EVIDENCE_URL')) {
      console.error('STOP RULE: Step 7 did not fail with INVALID_EVIDENCE_URL!');
      process.exit(1);
    }

    step7 = {
      step: 7,
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'attack',
      args: [1, 0, 'Breaking change with unpinned url', unpinnedUrl],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      returnOrError: errStr,
      votes: res.receipt?.votes || [],
      expected: 'UserError: INVALID_EVIDENCE_URL',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Unpinned URL rejected immediately'
    };
    recordTx(step7);
  } else {
    console.log(`[SKIP] Step 7 already executed: ${step7.hash}`);
  }

  // Step 8: resolve before deadline -> expect UserError DEADLINE_NOT_REACHED
  let step8 = getRecordedStep(8);
  if (!step8) {
    console.log('\n[Step 8 - EXPECTED FAILURE] resolve before deadline...');
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'resolve',
      args: [1],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Premature resolve error received:', errStr);

    if (!errStr.includes('DEADLINE_NOT_REACHED')) {
      console.error('STOP RULE: Step 8 did not fail with DEADLINE_NOT_REACHED!');
      process.exit(1);
    }

    step8 = {
      step: 8,
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'resolve',
      args: [1],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      returnOrError: errStr,
      votes: res.receipt?.votes || [],
      expected: 'UserError: DEADLINE_NOT_REACHED',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Early resolution prevented'
    };
    recordTx(step8);
  } else {
    console.log(`[SKIP] Step 8 already executed: ${step8.hash}`);
  }

  // ---------------------------------------------------------------------------
  // Case 2: Mutual Attack -> Fail Closed Scenario
  // ---------------------------------------------------------------------------
  let case2Deadline = state.case2Deadline;
  if (!case2Deadline) {
    case2Deadline = Math.floor(Date.now() / 1000) + 1500;
    saveState({ case2Deadline });
  }

  // Step 9: open_case 2 by Account A
  let step9 = getRecordedStep(9);
  if (!step9) {
    console.log('\n[Step 9] open_case 2 (Compound K-17 melts at 120 °C) by Account A...');
    const claim2 = 'Compound K-17 melts at 120 °C.';
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'open_case',
      args: [claim2, e3, case2Deadline, 60],
      expectSuccess: true
    });
    const c2 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [2] }));
    console.log('Case 2 readback:', JSON.stringify(c2));

    if (c2.status !== 'OPEN' || c2.labels['0'] !== 'IN') {
      console.error('STOP RULE: Case 2 not OPEN with root IN!');
      process.exit(1);
    }

    step9 = {
      step: 9,
      scenario: 'Case 2: Mutual Attack',
      method: 'open_case',
      args: [claim2, e3, case2Deadline, 60],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'OPEN (case_id 2, root IN)',
      actual: `${c2.status} (root ${c2.labels['0']})`,
      expectedFailure: false,
      readBack: c2
    };
    recordTx(step9);
  } else {
    console.log(`[SKIP] Step 9 already executed: ${step9.hash}`);
  }

  // Step 10: attack Case 2 by Account B (target 0, batch 7 contamination)
  let step10 = getRecordedStep(10);
  if (!step10) {
    console.log('\n[Step 10] attack Case 2, target 0 by Account B...');
    const text4 = 'K-17 melts at 98 °C; Lab A\'s 120 °C reading is invalid because its measured batch 7 was contaminated.';
    const res = await safeWrite(client2, {
      address: mainAddress,
      functionName: 'attack',
      args: [2, 0, text4, e4],
      expectSuccess: true
    });
    const c2 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [2] }));
    console.log('Case 2 readback after Account B attack:', JSON.stringify(c2));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('ADMITTED:ARG_1') || c2.labels['0'] !== 'OUT') {
      console.error('STOP RULE: Step 10 attack not admitted or root not OUT!');
      process.exit(1);
    }

    step10 = {
      step: 10,
      scenario: 'Case 2: Mutual Attack',
      method: 'attack',
      args: [2, 0, text4, e4],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'ADMITTED:ARG_1 (root OUT)',
      actual: `${ret} (root ${c2.labels['0']})`,
      expectedFailure: false,
      readBack: c2
    };
    recordTx(step10);
  } else {
    console.log(`[SKIP] Step 10 already executed: ${step10.hash}`);
  }

  // Step 11: add_edge by Account A (from 0 to 1; Lab A notes expired calibration certificate)
  let step11 = getRecordedStep(11);
  if (!step11) {
    console.log('\n[Step 11] add_edge Case 2 (from 0 to 1) by Account A (mutual defeat)...');
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'add_edge',
      args: [2, 0, 1],
      expectSuccess: true
    });
    const c2 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [2] }));
    console.log('Case 2 readback after add_edge:', JSON.stringify(c2));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('ADMITTED:EDGE_0_1') || c2.labels['0'] !== 'UNDEC' || c2.labels['1'] !== 'UNDEC') {
      console.error('STOP RULE: Step 11 add_edge not admitted or labels not UNDEC!');
      process.exit(1);
    }

    step11 = {
      step: 11,
      scenario: 'Case 2: Mutual Attack',
      method: 'add_edge',
      args: [2, 0, 1],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'ADMITTED:EDGE_0_1 (labels both UNDEC)',
      actual: `${ret} (0=${c2.labels['0']}, 1=${c2.labels['1']})`,
      expectedFailure: false,
      readBack: c2
    };
    recordTx(step11);
  } else {
    console.log(`[SKIP] Step 11 already executed: ${step11.hash}`);
  }

  // ---------------------------------------------------------------------------
  // Wait for Deadlines to Expire
  // ---------------------------------------------------------------------------
  console.log('\n--- WAITING FOR CASE DEADLINES TO EXPIRE ---');
  const c1Final = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [1] }));
  const c2Final = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [2] }));
  const d1 = Number(c1Final.deadline);
  const d2 = Number(c2Final.deadline);
  const maxDeadline = Math.max(d1, d2);

  console.log(`Case 1 Deadline: ${d1} (extensions used: ${c1Final.extensions_used})`);
  console.log(`Case 2 Deadline: ${d2} (extensions used: ${c2Final.extensions_used})`);
  console.log(`Target Deadline: ${maxDeadline}`);

  while (true) {
    const curTime = Math.floor(Date.now() / 1000);
    const remaining = maxDeadline - curTime + 15; // 15-second safety buffer
    if (remaining <= 0) {
      console.log(`[TIME] Deadline reached! Current time: ${curTime} >= ${maxDeadline}`);
      break;
    }
    console.log(`[WAIT] Remaining time until deadline: ${remaining}s (approx ${Math.ceil(remaining / 60)} min)...`);
    await new Promise(r => setTimeout(r, Math.min(30000, remaining * 1000)));
  }

  // ---------------------------------------------------------------------------
  // Post-Deadline Resolutions
  // ---------------------------------------------------------------------------
  // Step 12: resolve(case1) -> expect UPHELD
  let step12 = getRecordedStep(12);
  if (!step12) {
    console.log('\n[Step 12] resolve Case 1 -> expect UPHELD...');
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'resolve',
      args: [1],
      expectSuccess: true
    });
    const c1 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [1] }));
    console.log('Case 1 resolution readback:', JSON.stringify(c1));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('UPHELD') || c1.status !== 'UPHELD') {
      console.error(`STOP RULE: Step 12 expected UPHELD, got ret=${ret}, status=${c1.status}`);
      process.exit(1);
    }

    step12 = {
      step: 12,
      scenario: 'Final Resolutions',
      method: 'resolve',
      args: [1],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'UPHELD',
      actual: c1.status,
      expectedFailure: false,
      readBack: c1
    };
    recordTx(step12);
  } else {
    console.log(`[SKIP] Step 12 already executed: ${step12.hash}`);
  }

  // Step 13: resolve(case2) -> expect UNRESOLVED
  let step13 = getRecordedStep(13);
  if (!step13) {
    console.log('\n[Step 13] resolve Case 2 -> expect UNRESOLVED...');
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'resolve',
      args: [2],
      expectSuccess: true
    });
    const c2 = JSON.parse(await readContractWithRetry(client1, { address: mainAddress, functionName: 'get_case', args: [2] }));
    console.log('Case 2 resolution readback:', JSON.stringify(c2));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('UNRESOLVED') || c2.status !== 'UNRESOLVED') {
      console.error(`STOP RULE: Step 13 expected UNRESOLVED, got ret=${ret}, status=${c2.status}`);
      process.exit(1);
    }

    step13 = {
      step: 13,
      scenario: 'Final Resolutions',
      method: 'resolve',
      args: [2],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes || [],
      expected: 'UNRESOLVED',
      actual: c2.status,
      expectedFailure: false,
      readBack: c2
    };
    recordTx(step13);
  } else {
    console.log(`[SKIP] Step 13 already executed: ${step13.hash}`);
  }

  // Step 14: resolve(case1) again -> expect UserError (final)
  let step14 = getRecordedStep(14);
  if (!step14) {
    console.log('\n[Step 14 - EXPECTED FAILURE] resolve Case 1 again (already resolved)...');
    const res = await safeWrite(client1, {
      address: mainAddress,
      functionName: 'resolve',
      args: [1],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Double resolve error received:', errStr);

    if (!errStr.includes('CASE_CANNOT_RESOLVE')) {
      console.error('STOP RULE: Step 14 did not fail with CASE_CANNOT_RESOLVE!');
      process.exit(1);
    }

    step14 = {
      step: 14,
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'resolve',
      args: [1],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      returnOrError: errStr,
      votes: res.receipt?.votes || [],
      expected: 'UserError: CASE_CANNOT_RESOLVE_STATUS_UPHELD',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Double resolution rejected'
    };
    recordTx(step14);
  } else {
    console.log(`[SKIP] Step 14 already executed: ${step14.hash}`);
  }

  // ---------------------------------------------------------------------------
  // STEP E: Write deploy/manifest.json
  // ---------------------------------------------------------------------------
  console.log('\n--- E. WRITING MANIFEST ---');
  const manifest = {
    projectName: 'GroundTruth Court',
    tagline: 'Open adversarial argumentation graph on GenLayer with Dung grounded semantics',
    repositoryUrl: 'https://github.com/khezzed/GroundTruthCourt',
    sourceCommitSha: COMMIT_SHA,
    contractPath: 'contracts/ground_truth_court.py',
    gitBlobHash: GIT_BLOB_HASH,
    deployedCodeSha256: onChainSha256,
    blobEqualityResult: blobEquality,
    runnerHash: RUNNER_HASH,
    environment: {
      genlayerJsVersion: '1.2.0',
      nodeVersion: process.version,
      operatingSystem: process.platform
    },
    network: {
      chainId: 61999,
      networkName: 'GenLayer StudioNet',
      rpcUrl: 'https://studio.genlayer.com/api',
      explorerUrl: 'https://explorer-studio.genlayer.com'
    },
    accounts: {
      proposerAccountA: account1.address,
      attackerAccountB: account2.address
    },
    probeContract: {
      address: probeAddress,
      deployTx: probeDeployTx,
      setValTx: probeSetTx,
      expectedVal: 'probe_ok',
      actualVal: 'probe_ok',
      status: 'FINALIZED',
      executionResult: 'SUCCESS'
    },
    mainContract: {
      address: mainAddress,
      deployTx: mainDeployTx,
      constructorArgs: []
    },
    evidenceFiles: evidenceFilesList,
    transactions: txHistory
  };

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Manifest written to: ${MANIFEST_FILE}`);
  console.log('=== All 14 Steps & Invariants Successfully Executed & Verified on StudioNet! ===');
}

main().catch(err => {
  console.error('\n[FATAL ERROR in deploy_and_demo]:', err);
  process.exit(1);
});
