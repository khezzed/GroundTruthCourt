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

const COMMIT_V2 = 'c16d7ef11cea48034ad4fd5bf5453d08efec8729';
const GIT_BLOB_V2 = 'fe63af4e651c2f56b519552c132b20ed279bc585';
const EXPECTED_LOCAL_SHA256 = '6f3e70c15b9c6c600f9fd2a3486aafddbf6615147f6c8f9a835c1d783cdfcbd9';
const RUNNER_HASH = 'py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6';

// Pinned immutable evidence commit
const EVIDENCE_COMMIT = '757bfe0801412714cc81cbe7092bb4ffafa52f55';
const BASE_EVIDENCE_URL = `https://raw.githubusercontent.com/khezzed/GroundTruthCourt/${EVIDENCE_COMMIT}/evidence`;
const e0 = `${BASE_EVIDENCE_URL}/e0_release_notes_v2.txt`;
const e1 = `${BASE_EVIDENCE_URL}/e1_rc1_changelog.txt`;
const e2 = `${BASE_EVIDENCE_URL}/e2_final_tag_changelog.txt`;
const e3 = `${BASE_EVIDENCE_URL}/e3_lab_a.txt`;
const e4 = `${BASE_EVIDENCE_URL}/e4_lab_b.txt`;
const e5 = `${BASE_EVIDENCE_URL}/e5_unrelated.txt`;

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function normalizeReturn(val) {
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

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(patch) {
  const current = loadState();
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

function createStudioClient(account) {
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

async function waitForReceipt(client, txHash, { maxAttempts = 120, intervalMs = 8000, expectSuccess = true } = {}) {
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
      const votes = tx.consensus_data?.votes || {};

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
  console.log('  GroundTruth Court: StudioNet Clean Fresh Run (v2)            ');
  console.log('  Contract Commit: c16d7ef | Blob: fe63af4e                    ');
  console.log('===============================================================');

  // 0. Update manifest structure: preserve existing content under "superseded_v1"
  if (fs.existsSync(MANIFEST_FILE)) {
    const rawManifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'));
    if (!rawManifest.superseded_v1) {
      console.log('Archiving existing manifest under superseded_v1...');
      const archived = {
        superseded_v1: {
          note: 'superseded: prompt split in c16d7ef; v1 receipts do not prove v2 source',
          ...rawManifest
        },
        v2: null
      };
      fs.writeFileSync(MANIFEST_FILE, JSON.stringify(archived, null, 2), 'utf-8');
    }
  }

  const state = loadState();

  // 3. Setup THREE distinct accounts: A = proposer (deployer), B = attacker, C = defender
  let pkA = state.deployerPrivateKey;
  if (!pkA) {
    pkA = generatePrivateKey();
    saveState({ deployerPrivateKey: pkA });
  }
  let pkB = state.account2PrivateKey;
  if (!pkB) {
    pkB = generatePrivateKey();
    saveState({ account2PrivateKey: pkB });
  }
  let pkC = state.account3PrivateKey;
  if (!pkC) {
    pkC = generatePrivateKey();
    saveState({ account3PrivateKey: pkC });
  }

  const accountA = createAccount(pkA);
  const accountB = createAccount(pkB);
  const accountC = createAccount(pkC);

  console.log(`Account A (Proposer): ${accountA.address}`);
  console.log(`Account B (Attacker): ${accountB.address}`);
  console.log(`Account C (Defender): ${accountC.address}`);

  const clientA = createStudioClient(accountA);
  const clientB = createStudioClient(accountB);
  const clientC = createStudioClient(accountC);

  const v2History = state.v2History || [];
  function recordV2Step(item) {
    v2History.push(item);
    saveState({ v2History });
    console.log(`  [RECORDED v2 STEP ${item.step}] ${item.method} | Hash: ${item.hash || 'N/A'} | Status: ${item.status || 'CLIENT_ERROR'} | Exec: ${item.executionResult || 'N/A'}`);
  }

  function getV2Step(stepId) {
    return v2History.find(t => String(t.step) === String(stepId));
  }

  // 1. Re-run Probe Contract (write + read, FINALIZED + SUCCESS)
  console.log('\n--- STEP 1: PROBE CONTRACT VERIFICATION ---');
  let probeAddress = state.v2ProbeAddress;
  let probeDeployTx = state.v2ProbeDeployTx;
  let probeSetTx = state.v2ProbeSetTx;

  if (!probeAddress) {
    const probePath = path.join(ROOT_DIR, 'deploy', 'probe.py');
    const probeCode = fs.readFileSync(probePath, 'utf-8');
    console.log(`Deploying probe.py (${probeCode.length} bytes)...`);
    probeDeployTx = await clientA.deployContract({ code: probeCode });
    const probeReceipt = await waitForReceipt(clientA, probeDeployTx, { expectSuccess: true });
    probeAddress = probeReceipt.contractAddress;
    saveState({ v2ProbeAddress: probeAddress, v2ProbeDeployTx: probeDeployTx });
    console.log(`Probe contract finalized at: ${probeAddress}`);

    console.log('Writing on Probe: set_val("v2_probe_ok")...');
    probeSetTx = await clientA.writeContract({
      address: probeAddress,
      functionName: 'set_val',
      args: ['v2_probe_ok']
    });
    await waitForReceipt(clientA, probeSetTx, { expectSuccess: true });
    saveState({ v2ProbeSetTx: probeSetTx });

    const probeVal = await readContractWithRetry(clientA, {
      address: probeAddress,
      functionName: 'get_val',
      args: []
    });
    console.log(`Probe readback get_val: "${probeVal}"`);
    if (probeVal !== 'v2_probe_ok') {
      throw new Error(`Probe check failed: expected 'v2_probe_ok', got '${probeVal}'`);
    }
    console.log('[PASS] Probe verified on StudioNet!');
  } else {
    console.log(`[SKIP] Probe already deployed at: ${probeAddress}`);
  }

  // 2. Deploy contracts/ground_truth_court.py from commit c16d7ef
  console.log('\n--- STEP 2: DEPLOY MAIN CONTRACT (v2) & VERIFY INTEGRITY ---');
  let v2ContractAddress = state.v2ContractAddress;
  let v2DeployTx = state.v2DeployTx;

  const mainPath = path.join(ROOT_DIR, 'contracts', 'ground_truth_court.py');
  const mainCode = fs.readFileSync(mainPath, 'utf-8');
  const localSha256 = sha256(mainCode);
  console.log(`Local contract path    : ${mainPath}`);
  console.log(`Local contract size    : ${mainCode.length} bytes`);
  console.log(`Git blob hash (sha1)   : ${GIT_BLOB_V2}`);
  console.log(`Local source sha256    : ${localSha256}`);

  if (localSha256 !== EXPECTED_LOCAL_SHA256) {
    throw new Error(`Local source sha256 mismatch! Expected ${EXPECTED_LOCAL_SHA256}, got ${localSha256}`);
  }

  if (!v2ContractAddress) {
    console.log(`Deploying GroundTruthCourt v2 (${mainCode.length} bytes)...`);
    v2DeployTx = await clientA.deployContract({ code: mainCode });
    console.log(`Main v2 Deploy Tx: ${v2DeployTx}`);
    const mainReceipt = await waitForReceipt(clientA, v2DeployTx, { expectSuccess: true });
    v2ContractAddress = mainReceipt.contractAddress;
    console.log(`Main Contract v2 Finalized at: ${v2ContractAddress}`);
    saveState({ v2ContractAddress, v2DeployTx });
  } else {
    console.log(`[SKIP] Main contract v2 already deployed at: ${v2ContractAddress}`);
  }

  // Fetch deployed on-chain code and verify byte-for-byte equality
  console.log('Fetching deployed code from StudioNet RPC...');
  const onChainCode = await clientA.getContractCode(v2ContractAddress);
  const onChainSha256 = sha256(onChainCode);
  console.log(`On-chain code sha256   : ${onChainSha256}`);

  const blobEquality = (mainCode === onChainCode) && (localSha256 === onChainSha256);
  console.log(`Byte-for-byte equality : ${blobEquality ? 'MATCH (100%)' : 'MISMATCH'}`);
  if (!blobEquality) {
    throw new Error(`CRITICAL: Bytecode mismatch against deployed contract!`);
  }

  // ---------------------------------------------------------------------------
  // STEP 3: DEMO EXECUTION (Case R, Case M, Expected Failures, Resolutions)
  // ---------------------------------------------------------------------------
  console.log('\n--- STEP 3: CLEAN DEMO EXECUTION ---');

  let deadlineR = state.v2DeadlineR;
  let deadlineM = state.v2DeadlineM;
  if (!deadlineR) {
    const now = Math.floor(Date.now() / 1000);
    deadlineR = now + 3600;
    deadlineM = now + 3600;
    saveState({ v2DeadlineR: deadlineR, v2DeadlineM: deadlineM });
  }

  // Helper for executing attack with at most ONE identical resubmission on consensus non-agreement
  async function attackWithResubmission(client, { caseId, targetId, text, evidenceUrl, stepName }) {
    console.log(`\n[${stepName}] Executing attack on Case ${caseId}, target ${targetId}...`);
    let res = await safeWrite(client, {
      address: v2ContractAddress,
      functionName: 'attack',
      args: [caseId, targetId, text, evidenceUrl],
      expectSuccess: false
    });

    let retStr = String(normalizeReturn(res.receipt?.returnReadable) || res.clientError?.message || res.receipt?.stderr || '');
    let consensusResult = res.receipt?.result || 'UNKNOWN';

    // If consensus non-agreement (MAJORITY_DISAGREE / UNDETERMINED with no state change), allow at most ONE resubmission
    if (consensusResult === 'MAJORITY_DISAGREE' || consensusResult === 'UNDETERMINED') {
      console.warn(`  [Consensus non-agreement in ${stepName}]: ${consensusResult}. Making ONE identical resubmission...`);
      res = await safeWrite(client, {
        address: v2ContractAddress,
        functionName: 'attack',
        args: [caseId, targetId, text, evidenceUrl],
        expectSuccess: false
      });
      retStr = String(normalizeReturn(res.receipt?.returnReadable) || res.clientError?.message || res.receipt?.stderr || '');
      consensusResult = res.receipt?.result || 'UNKNOWN';
    }

    return { res, retStr, consensusResult };
  }

  // Helper for add_edge with at most ONE identical resubmission on consensus non-agreement
  async function addEdgeWithResubmission(client, { caseId, fromId, toId, stepName }) {
    console.log(`\n[${stepName}] Executing add_edge on Case ${caseId} (from ${fromId} to ${toId})...`);
    let res = await safeWrite(client, {
      address: v2ContractAddress,
      functionName: 'add_edge',
      args: [caseId, fromId, toId],
      expectSuccess: false
    });

    let retStr = String(normalizeReturn(res.receipt?.returnReadable) || res.clientError?.message || res.receipt?.stderr || '');
    let consensusResult = res.receipt?.result || 'UNKNOWN';

    if (consensusResult === 'MAJORITY_DISAGREE' || consensusResult === 'UNDETERMINED') {
      console.warn(`  [Consensus non-agreement in ${stepName}]: ${consensusResult}. Making ONE identical resubmission...`);
      res = await safeWrite(client, {
        address: v2ContractAddress,
        functionName: 'add_edge',
        args: [caseId, fromId, toId],
        expectSuccess: false
      });
      retStr = String(normalizeReturn(res.receipt?.returnReadable) || res.clientError?.message || res.receipt?.stderr || '');
      consensusResult = res.receipt?.result || 'UNKNOWN';
    }

    return { res, retStr, consensusResult };
  }

  // ===========================================================================
  // Case R (Reinstatement)
  // ===========================================================================
  console.log('\n--- Case R (Reinstatement) ---');

  // R1: Account A opens Case R
  let stepR1 = getV2Step('R1');
  if (!stepR1) {
    console.log('\n[R1] Account A open_case("tinyjson v2.0.0 is backward compatible with the v1.x parse() API.", e0)...');
    const claimR = 'tinyjson v2.0.0 is backward compatible with the v1.x parse() API.';
    const res = await safeWrite(clientA, {
      address: v2ContractAddress,
      functionName: 'open_case',
      args: [claimR, e0, deadlineR, 60],
      expectSuccess: true
    });
    const cR = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [1] }));
    console.log('Case R readback after R1:', JSON.stringify(cR));

    if (cR.status !== 'OPEN' || cR.labels['0'] !== 'IN') {
      console.error('STOP RULE: Case R not OPEN with root IN!');
      process.exit(1);
    }

    stepR1 = {
      step: 'R1',
      scenario: 'Case R (Reinstatement)',
      method: 'open_case',
      account: 'A',
      args: [claimR, e0, deadlineR, 60],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes,
      expected: 'OPEN (root IN)',
      actual: `${cR.status} (root ${cR.labels['0']})`,
      expectedFailure: false,
      readBack: cR
    };
    recordV2Step(stepR1);
  } else {
    console.log(`[SKIP] R1 already executed: ${stepR1.hash}`);
  }

  // R2: Account B attacks target 0 with e1
  let stepR2 = getV2Step('R2');
  if (!stepR2) {
    const textR2 = 'v2.0.0 removed the strict parameter from parse(), so v1.x callers passing strict=True break.';
    const { res, retStr, consensusResult } = await attackWithResubmission(clientB, {
      caseId: 1,
      targetId: 0,
      text: textR2,
      evidenceUrl: e1,
      stepName: 'R2'
    });

    const cR = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [1] }));
    console.log('Case R readback after R2:', JSON.stringify(cR));

    if (!retStr.includes('ADMITTED:ARG_1') || cR.labels['0'] !== 'OUT') {
      console.error(`STOP RULE: R2 was not admitted (got ${retStr}, root=${cR.labels['0']})!`);
      stepR2 = {
        step: 'R2',
        scenario: 'Case R (Reinstatement)',
        method: 'attack',
        account: 'B',
        args: [1, 0, textR2, e1],
        hash: res.txHash,
        status: res.receipt?.status,
        executionResult: res.receipt?.executionResult,
        consensusResult,
        returnOrError: retStr,
        votes: res.receipt?.votes,
        expected: 'ADMITTED:ARG_1 (root OUT)',
        actual: retStr,
        expectedFailure: false,
        stopRuleTriggered: true,
        readBack: cR
      };
      recordV2Step(stepR2);
      process.exit(1);
    }

    stepR2 = {
      step: 'R2',
      scenario: 'Case R (Reinstatement)',
      method: 'attack',
      account: 'B',
      args: [1, 0, textR2, e1],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult,
      returnOrError: retStr,
      votes: res.receipt.votes,
      expected: 'ADMITTED:ARG_1 (root OUT)',
      actual: `${retStr} (root ${cR.labels['0']})`,
      expectedFailure: false,
      readBack: cR
    };
    recordV2Step(stepR2);
  } else {
    console.log(`[SKIP] R2 already executed: ${stepR2.hash}`);
  }

  // R3: Account C attacks target 1 with e2 (reinstatement)
  let stepR3 = getV2Step('R3');
  if (!stepR3) {
    const textR3 = 'The strict removal was only in v2.0.0-rc1 and was reverted before the v2.0.0 final tag, which still ships parse(text, strict=False).';
    const { res, retStr, consensusResult } = await attackWithResubmission(clientC, {
      caseId: 1,
      targetId: 1,
      text: textR3,
      evidenceUrl: e2,
      stepName: 'R3'
    });

    const cR = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [1] }));
    console.log('Case R readback after R3:', JSON.stringify(cR));

    if (!retStr.includes('ADMITTED:ARG_2') || cR.labels['0'] !== 'IN') {
      console.error(`STOP RULE: R3 was not admitted (got ${retStr}, root=${cR.labels['0']})!`);
      stepR3 = {
        step: 'R3',
        scenario: 'Case R (Reinstatement)',
        method: 'attack',
        account: 'C',
        args: [1, 1, textR3, e2],
        hash: res.txHash,
        status: res.receipt?.status,
        executionResult: res.receipt?.executionResult,
        consensusResult,
        returnOrError: retStr,
        votes: res.receipt?.votes,
        expected: 'ADMITTED:ARG_2 (root IN)',
        actual: retStr,
        expectedFailure: false,
        stopRuleTriggered: true,
        readBack: cR
      };
      recordV2Step(stepR3);
      process.exit(1);
    }

    stepR3 = {
      step: 'R3',
      scenario: 'Case R (Reinstatement)',
      method: 'attack',
      account: 'C',
      args: [1, 1, textR3, e2],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult,
      returnOrError: retStr,
      votes: res.receipt.votes,
      expected: 'ADMITTED:ARG_2 (root IN)',
      actual: `${retStr} (root ${cR.labels['0']})`,
      expectedFailure: false,
      readBack: cR
    };
    recordV2Step(stepR3);
  } else {
    console.log(`[SKIP] R3 already executed: ${stepR3.hash}`);
  }

  // ===========================================================================
  // Case M (Mutual Attack -> Fail Closed)
  // ===========================================================================
  console.log('\n--- Case M (Mutual Attack -> Fail Closed) ---');

  // M1: Account A opens Case M
  let stepM1 = getV2Step('M1');
  if (!stepM1) {
    console.log('\n[M1] Account A open_case("Compound K-17 melts at 120 °C; Lab B\'s 98 °C reading is invalid...", e3)...');
    const claimM = "Compound K-17 melts at 120 °C; Lab B's 98 °C reading is invalid because Lab B's thermometer calibration certificate had expired.";
    const res = await safeWrite(clientA, {
      address: v2ContractAddress,
      functionName: 'open_case',
      args: [claimM, e3, deadlineM, 60],
      expectSuccess: true
    });
    const cM = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [2] }));
    console.log('Case M readback after M1:', JSON.stringify(cM));

    if (cM.status !== 'OPEN' || cM.labels['0'] !== 'IN') {
      console.error('STOP RULE: Case M not OPEN with root IN!');
      process.exit(1);
    }

    stepM1 = {
      step: 'M1',
      scenario: 'Case M (Mutual Attack)',
      method: 'open_case',
      account: 'A',
      args: [claimM, e3, deadlineM, 60],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes,
      expected: 'OPEN (root IN)',
      actual: `${cM.status} (root ${cM.labels['0']})`,
      expectedFailure: false,
      readBack: cM
    };
    recordV2Step(stepM1);
  } else {
    console.log(`[SKIP] M1 already executed: ${stepM1.hash}`);
  }

  // M2: Account B attacks target 0 with e4
  let stepM2 = getV2Step('M2');
  if (!stepM2) {
    const textM2 = "K-17 melts at 98 °C; Lab A's 120 °C reading is invalid because its measured batch 7 was contaminated.";
    const { res, retStr, consensusResult } = await attackWithResubmission(clientB, {
      caseId: 2,
      targetId: 0,
      text: textM2,
      evidenceUrl: e4,
      stepName: 'M2'
    });

    const cM = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [2] }));
    console.log('Case M readback after M2:', JSON.stringify(cM));

    if (!retStr.includes('ADMITTED:ARG_1') || cM.labels['0'] !== 'OUT') {
      console.error(`STOP RULE: M2 was not admitted (got ${retStr}, root=${cM.labels['0']})!`);
      stepM2 = {
        step: 'M2',
        scenario: 'Case M (Mutual Attack)',
        method: 'attack',
        account: 'B',
        args: [2, 0, textM2, e4],
        hash: res.txHash,
        status: res.receipt?.status,
        executionResult: res.receipt?.executionResult,
        consensusResult,
        returnOrError: retStr,
        votes: res.receipt?.votes,
        expected: 'ADMITTED:ARG_1 (root OUT)',
        actual: retStr,
        expectedFailure: false,
        stopRuleTriggered: true,
        readBack: cM
      };
      recordV2Step(stepM2);
      process.exit(1);
    }

    stepM2 = {
      step: 'M2',
      scenario: 'Case M (Mutual Attack)',
      method: 'attack',
      account: 'B',
      args: [2, 0, textM2, e4],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult,
      returnOrError: retStr,
      votes: res.receipt.votes,
      expected: 'ADMITTED:ARG_1 (root OUT)',
      actual: `${retStr} (root ${cM.labels['0']})`,
      expectedFailure: false,
      readBack: cM
    };
    recordV2Step(stepM2);
  } else {
    console.log(`[SKIP] M2 already executed: ${stepM2.hash}`);
  }

  // M3: Account A adds edge from 0 to 1 (mutual defeat)
  let stepM3 = getV2Step('M3');
  if (!stepM3) {
    const { res, retStr, consensusResult } = await addEdgeWithResubmission(clientA, {
      caseId: 2,
      fromId: 0,
      toId: 1,
      stepName: 'M3'
    });

    const cM = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [2] }));
    console.log('Case M readback after M3:', JSON.stringify(cM));

    if (!retStr.includes('ADMITTED:EDGE_0_1') || cM.labels['0'] !== 'UNDEC' || cM.labels['1'] !== 'UNDEC') {
      console.error(`STOP RULE: M3 was not admitted (got ${retStr}, 0=${cM.labels['0']}, 1=${cM.labels['1']})!`);
      stepM3 = {
        step: 'M3',
        scenario: 'Case M (Mutual Attack)',
        method: 'add_edge',
        account: 'A',
        args: [2, 0, 1],
        hash: res.txHash,
        status: res.receipt?.status,
        executionResult: res.receipt?.executionResult,
        consensusResult,
        returnOrError: retStr,
        votes: res.receipt?.votes,
        expected: 'ADMITTED:EDGE_0_1 (labels {0: UNDEC, 1: UNDEC})',
        actual: retStr,
        expectedFailure: false,
        stopRuleTriggered: true,
        readBack: cM
      };
      recordV2Step(stepM3);
      process.exit(1);
    }

    stepM3 = {
      step: 'M3',
      scenario: 'Case M (Mutual Attack)',
      method: 'add_edge',
      account: 'A',
      args: [2, 0, 1],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult,
      returnOrError: retStr,
      votes: res.receipt.votes,
      expected: 'ADMITTED:EDGE_0_1 (labels {0: UNDEC, 1: UNDEC})',
      actual: `${retStr} (0=${cM.labels['0']}, 1=${cM.labels['1']})`,
      expectedFailure: false,
      readBack: cM
    };
    recordV2Step(stepM3);
  } else {
    console.log(`[SKIP] M3 already executed: ${stepM3.hash}`);
  }

  // ===========================================================================
  // EXPECTED FAILURES (X1 to X5)
  // ===========================================================================
  console.log('\n--- EXPECTED FAILURES (X1 to X5) ---');

  // X1: Account B attacks target 0 with e5_unrelated -> expect REJECTED return (FINALIZED+SUCCESS, not admitted)
  let stepX1 = getV2Step('X1');
  if (!stepX1) {
    console.log('\n[X1] Account B attacks Case R target 0 with unrelated evidence (cookies)...');
    const textX1 = 'tinyjson v2.0.0 breaks compatibility.';
    const res = await safeWrite(clientB, {
      address: v2ContractAddress,
      functionName: 'attack',
      args: [1, 0, textX1, e5],
      expectSuccess: true
    });
    const cR = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [1] }));
    console.log('Case R readback after X1:', JSON.stringify(cR));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('REJECTED')) {
      console.error(`STOP RULE: X1 was unexpectedly admitted! Got ${ret}`);
      process.exit(1);
    }

    stepX1 = {
      step: 'X1',
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'attack',
      account: 'B',
      args: [1, 0, textX1, e5],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: ret,
      votes: res.receipt.votes,
      expected: 'REJECTED return (FINALIZED+SUCCESS, not admitted)',
      actual: ret,
      expectedFailure: true,
      readBack: { totalArgs: cR.args.length, rootLabel: cR.labels['0'] }
    };
    recordV2Step(stepX1);
  } else {
    console.log(`[SKIP] X1 already executed: ${stepX1.hash}`);
  }

  // X2: Account B replays R2 exactly -> UserError REPLAY
  let stepX2 = getV2Step('X2');
  if (!stepX2) {
    console.log('\n[X2] Account B replays R2 exact submission...');
    const textR2 = 'v2.0.0 removed the strict parameter from parse(), so v1.x callers passing strict=True break.';
    const res = await safeWrite(clientB, {
      address: v2ContractAddress,
      functionName: 'attack',
      args: [1, 0, textR2, e1],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Replay error received:', errStr);

    if (!errStr.includes('REPLAY')) {
      console.error('STOP RULE: X2 did not fail with REPLAY!');
      process.exit(1);
    }

    stepX2 = {
      step: 'X2',
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'attack',
      account: 'B',
      args: [1, 0, textR2, e1],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: REPLAY',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Replay prevented'
    };
    recordV2Step(stepX2);
  } else {
    console.log(`[SKIP] X2 already executed: ${stepX2.hash}`);
  }

  // X3: Account C calls add_edge(R, 1, 2) -> UserError unauthorized (C is not arg 1's author)
  let stepX3 = getV2Step('X3');
  if (!stepX3) {
    console.log('\n[X3] Account C calls add_edge(Case R, from 1, to 2) (C is not author of arg 1)...');
    const res = await safeWrite(clientC, {
      address: v2ContractAddress,
      functionName: 'add_edge',
      args: [1, 1, 2],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Unauthorized error received:', errStr);

    if (!errStr.toLowerCase().includes('unauthorized')) {
      console.error('STOP RULE: X3 did not fail with unauthorized!');
      process.exit(1);
    }

    stepX3 = {
      step: 'X3',
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'add_edge',
      account: 'C',
      args: [1, 1, 2],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: unauthorized',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Unauthorized add_edge prevented'
    };
    recordV2Step(stepX3);
  } else {
    console.log(`[SKIP] X3 already executed: ${stepX3.hash}`);
  }

  // X4: Account B attacks target 0 with unpinned /main/ URL -> INVALID_EVIDENCE_URL
  let stepX4 = getV2Step('X4');
  if (!stepX4) {
    console.log('\n[X4] Account B attacks with unpinned /main/ branch URL...');
    const unpinnedUrl = 'https://raw.githubusercontent.com/khezzed/GroundTruthCourt/main/evidence/e1_rc1_changelog.txt';
    const res = await safeWrite(clientB, {
      address: v2ContractAddress,
      functionName: 'attack',
      args: [1, 0, 'Breaking change with unpinned url', unpinnedUrl],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Invalid URL error received:', errStr);

    if (!errStr.includes('INVALID_EVIDENCE_URL')) {
      console.error('STOP RULE: X4 did not fail with INVALID_EVIDENCE_URL!');
      process.exit(1);
    }

    stepX4 = {
      step: 'X4',
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'attack',
      account: 'B',
      args: [1, 0, 'Breaking change with unpinned url', unpinnedUrl],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: INVALID_EVIDENCE_URL',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Unpinned URL rejected immediately'
    };
    recordV2Step(stepX4);
  } else {
    console.log(`[SKIP] X4 already executed: ${stepX4.hash}`);
  }

  // X5: Anyone calls resolve(Case R) before deadline -> DEADLINE_NOT_REACHED
  let stepX5 = getV2Step('X5');
  if (!stepX5) {
    console.log('\n[X5] Account A calls resolve(Case R) before deadline...');
    const res = await safeWrite(clientA, {
      address: v2ContractAddress,
      functionName: 'resolve',
      args: [1],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Early resolve error received:', errStr);

    if (!errStr.includes('DEADLINE_NOT_REACHED')) {
      console.error('STOP RULE: X5 did not fail with DEADLINE_NOT_REACHED!');
      process.exit(1);
    }

    stepX5 = {
      step: 'X5',
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'resolve',
      account: 'A',
      args: [1],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: DEADLINE_NOT_REACHED',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Early resolve rejected'
    };
    recordV2Step(stepX5);
  } else {
    console.log(`[SKIP] X5 already executed: ${stepX5.hash}`);
  }

  // ===========================================================================
  // Wait for Deadlines (Case R and Case M)
  // ===========================================================================
  console.log('\n--- WAITING FOR CASE DEADLINES TO EXPIRE (Case R & Case M) ---');
  const cRCheck = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [1] }));
  const cMCheck = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [2] }));
  const dR = Number(cRCheck.deadline);
  const dM = Number(cMCheck.deadline);
  const maxDeadline = Math.max(dR, dM);

  console.log(`Case R Deadline: ${dR} (extensions used: ${cRCheck.extensions_used})`);
  console.log(`Case M Deadline: ${dM} (extensions used: ${cMCheck.extensions_used})`);
  console.log(`Target Deadline: ${maxDeadline}`);

  while (true) {
    const curTime = Math.floor(Date.now() / 1000);
    const remaining = maxDeadline - curTime + 15; // 15s buffer
    if (remaining <= 0) {
      console.log(`[TIME] Deadline reached! Current time: ${curTime} >= ${maxDeadline}`);
      break;
    }
    console.log(`[WAIT] Remaining time until deadline: ${remaining}s (approx ${Math.ceil(remaining / 60)} min)...`);
    await new Promise(r => setTimeout(r, Math.min(30000, remaining * 1000)));
  }

  // ===========================================================================
  // After Deadlines: F1, F2, X6
  // ===========================================================================
  console.log('\n--- POST-DEADLINE RESOLUTIONS ---');

  // F1: resolve(Case R) -> expect UPHELD
  let stepF1 = getV2Step('F1');
  if (!stepF1) {
    console.log('\n[F1] resolve Case R -> expect UPHELD...');
    const res = await safeWrite(clientA, {
      address: v2ContractAddress,
      functionName: 'resolve',
      args: [1],
      expectSuccess: true
    });
    const cR = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [1] }));
    console.log('Case R resolution readback:', JSON.stringify(cR));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('UPHELD') || cR.status !== 'UPHELD') {
      throw new Error(`F1 expected UPHELD, got ret=${ret}, status=${cR.status}`);
    }

    stepF1 = {
      step: 'F1',
      scenario: 'Final Resolutions',
      method: 'resolve',
      account: 'A',
      args: [1],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes,
      expected: 'UPHELD',
      actual: cR.status,
      expectedFailure: false,
      readBack: cR
    };
    recordV2Step(stepF1);
  } else {
    console.log(`[SKIP] F1 already executed: ${stepF1.hash}`);
  }

  // F2: resolve(Case M) -> expect UNRESOLVED
  let stepF2 = getV2Step('F2');
  if (!stepF2) {
    console.log('\n[F2] resolve Case M -> expect UNRESOLVED...');
    const res = await safeWrite(clientA, {
      address: v2ContractAddress,
      functionName: 'resolve',
      args: [2],
      expectSuccess: true
    });
    const cM = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [2] }));
    console.log('Case M resolution readback:', JSON.stringify(cM));

    const ret = String(normalizeReturn(res.receipt.returnReadable));
    if (!ret.includes('UNRESOLVED') || cM.status !== 'UNRESOLVED') {
      throw new Error(`F2 expected UNRESOLVED, got ret=${ret}, status=${cM.status}`);
    }

    stepF2 = {
      step: 'F2',
      scenario: 'Final Resolutions',
      method: 'resolve',
      account: 'A',
      args: [2],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: res.receipt.returnReadable,
      votes: res.receipt.votes,
      expected: 'UNRESOLVED',
      actual: cM.status,
      expectedFailure: false,
      readBack: cM
    };
    recordV2Step(stepF2);
  } else {
    console.log(`[SKIP] F2 already executed: ${stepF2.hash}`);
  }

  // X6: resolve(Case R) again -> expect UserError (final)
  let stepX6 = getV2Step('X6');
  if (!stepX6) {
    console.log('\n[X6 - EXPECTED FAILURE] resolve Case R again (already resolved)...');
    const res = await safeWrite(clientA, {
      address: v2ContractAddress,
      functionName: 'resolve',
      args: [1],
      expectSuccess: false
    });
    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('Double resolve error received:', errStr);

    if (!errStr.includes('CASE_CANNOT_RESOLVE')) {
      throw new Error(`X6 did not fail with CASE_CANNOT_RESOLVE! Got: ${errStr}`);
    }

    stepX6 = {
      step: 'X6',
      scenario: 'Expected Failures / Abuse Blocked',
      method: 'resolve',
      account: 'A',
      args: [1],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: CASE_CANNOT_RESOLVE_STATUS_UPHELD',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Double resolution rejected'
    };
    recordV2Step(stepX6);
  } else {
    console.log(`[SKIP] X6 already executed: ${stepX6.hash}`);
  }

  // ===========================================================================
  // Update deploy/manifest.json with top-level v2 section
  // ===========================================================================
  console.log('\n--- UPDATING MANIFEST WITH v2 SECTION ---');
  const finalManifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'));

  const cRFinal = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [1] }));
  const cMFinal = JSON.parse(await readContractWithRetry(clientA, { address: v2ContractAddress, functionName: 'get_case', args: [2] }));

  finalManifest.v2 = {
    projectName: 'GroundTruth Court v2',
    description: 'Clean fresh run with split premise/edge prompts (commit c16d7ef)',
    sourceCommitSha: COMMIT_V2,
    contractPath: 'contracts/ground_truth_court.py',
    gitBlobHash: GIT_BLOB_V2,
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
      proposerAccountA: accountA.address,
      attackerAccountB: accountB.address,
      defenderAccountC: accountC.address
    },
    probeContract: {
      address: probeAddress,
      deployTx: probeDeployTx,
      setValTx: probeSetTx,
      expectedVal: 'v2_probe_ok',
      actualVal: 'v2_probe_ok',
      status: 'FINALIZED',
      executionResult: 'SUCCESS'
    },
    mainContract: {
      address: v2ContractAddress,
      deployTx: v2DeployTx,
      constructorArgs: []
    },
    evidenceFiles: [
      { name: 'e0_release_notes_v2.txt', url: e0, rawBytes: 221, httpCode: 200, sha256: '0a7f02b7682dfff51cd60fd3e7942c236df4a691cd321dc6851a523bf9b840c3' },
      { name: 'e1_rc1_changelog.txt', url: e1, rawBytes: 184, httpCode: 200, sha256: '2b025100742f284fe2013eb29a35a4529811bab79dd079c0eb1806c71b252eaf' },
      { name: 'e2_final_tag_changelog.txt', url: e2, rawBytes: 293, httpCode: 200, sha256: '685e4c5622446845ecc05fc48668ce1a493fd14417a800a094d9bd288290a974' },
      { name: 'e3_lab_a.txt', url: e3, rawBytes: 217, httpCode: 200, sha256: '118e919f3c682e1c1ae7b9ca039b289fd9216807d4ed3dc64a125f7ca09df452' },
      { name: 'e4_lab_b.txt', url: e4, rawBytes: 207, httpCode: 200, sha256: '2c4a694ec9e04d8128455639bf05b57e0917af9e2a65d427522091708fd75849' },
      { name: 'e5_unrelated.txt', url: e5, rawBytes: 237, httpCode: 200, sha256: 'a72891b5f880b7688c1a790828ddf47ec52ba73df12fa6272b3aadef531bd99f' }
    ],
    cases: {
      caseR: cRFinal,
      caseM: cMFinal
    },
    transactions: v2History
  };

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(finalManifest, null, 2), 'utf-8');
  console.log(`Manifest updated at: ${MANIFEST_FILE}`);
  console.log('=== All v2 Steps Successfully Executed on StudioNet! ===');
}

main().catch(err => {
  console.error('[FATAL in v2_deploy_and_demo]:', err);
  process.exit(1);
});
