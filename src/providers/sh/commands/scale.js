#!/usr/bin/env node
// @flow

// Packages
const ms = require('ms');
const chalk = require('chalk')
const arg = require('arg')
const sleep = require('then-sleep');

// Utilities
const cmd = require('../../../util/output/cmd')
const createOutput = require('../../../util/output')
const Now = require('../util/')
const logo = require('../../../util/output/logo')
const elapsed = require('../../../util/output/elapsed')
const argCommon = require('../util/arg-common')()
const wait = require('../../../util/output/wait')
const { tick } = require('../../../util/output/chars')
const { normalizeRegionsList } = require('../util/dcs')
const { handleError } = require('../util/error')
const getContextName = require('../util/get-context-name')
const exit = require('../../../util/exit')

// the "auto" value for scaling
const AUTO = 'auto'

// deployment type
const TYPE_STATIC = 'STATIC'

// states
const STATE_ERROR = 'ERROR'

const help = () => {
  console.log(`
  ${chalk.bold(`${logo} now scale`)} <url> <dc> [min] [max]

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline('FILE')}   Path to the local ${'`now.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline('DIR')}    Path to the global ${'`.now`'} directory
    -t ${chalk.bold.underline('TOKEN')}, --token=${chalk.bold.underline('TOKEN')}        Login token
    -d, --debug                    Debug mode [off]
    -T, --team                     Set a custom team scope
    -n, --no-verify                Skip step of waiting until instance count meets given constraints
    -t, --verify-timeout           How long to wait for verification to complete [5m]

  ${chalk.dim('Examples:')}

  ${chalk.gray('–')} Enable your deployment in all datacenters (min: 0, max: 1)

    ${chalk.cyan('$ now scale my-deployment-123.now.sh all')}

  ${chalk.gray('-')} Enable your deployment in the SFO datacenter (min: 0, max: 1)

    ${chalk.cyan('$ now scale my-deployment-123.now.sh sfo')}

  ${chalk.gray('–')} Scale a deployment in all datacenters to 3 instances at all times (no sleep)

    ${chalk.cyan('$ now scale my-deployment-123.now.sh all 3')}

  ${chalk.gray('–')} Enable your deployment in all datacenters, with auto-scaling

    ${chalk.cyan('$ now scale my-deployment-123.now.sh all auto')}
  `)
}

// $FlowFixMe
module.exports = async function main (ctx) {
  let id // Deployment Id or URL

  let dcIds = null // Target DCs
  let min = null // Minimum number of instances
  let max = null // Maximum number of instances

  let deployment
  let argv;

  try {
    argv = arg(ctx.argv.slice(3), {
      ...argCommon,
      '--no-verify': Boolean,
      '-n': '--no-verify',
      '--verify-timeout': String,
      '-t': '--verify-timeout'
    })
  } catch (err) {
    handleError(err)
    return 1;
  }

  if (argv['--help']) {
    help()
    return 2;
  }

  const apiUrl = ctx.apiUrl
  const debugEnabled = argv['--debug']
  const output = createOutput({ debug: debugEnabled })
  const { log, success, error, debug } = output;

  // extract the first parameter
  id = argv._[0]

  // `now scale ls` has been deprecated
  if (id === 'ls') {
    error(`${cmd('now scale ls')} has been deprecated. Use ${cmd('now ls')} and ${cmd('now inspect <url>')}`, 'scale-ls')
    return 1
  }

  if (argv._.length < 2) {
    error(`${cmd('now scale <url> <dc> [min] [max]')} expects at least two arguments`)
    help();
    return 1;
  }

  if (argv._.length > 4) {
    error(`${cmd('now scale <url> <dc> [min] [max]')} expects at most four arguments`)
    help();
    return 1;
  }

  if (argv['--verify-timeout'] != null && argv['--no-verify']) {
    error('The options `--verify-timeout` and `--no-verify` cannot be used at once');
    return 1;
  }

  if (null != argv['--verify-timeout'] && !Number.isInteger(ms(argv['--verify-timeout']))) {
    error('Invalid time string for `--verify-timeout`. Should be a number of miliseconds or a string like "3m"');
    return 1;
  }

  // for legacy reasons, we still allow `now scale <url> <min> [max]`.
  // if this is the case, we apply the desired rules to all dcs
  let dcIdOrMin = argv._[1];

  if (isMinOrMaxArgument(dcIdOrMin)) {
    min = toMin(dcIdOrMin)

    const maybeMax = argv._[2];
    if (maybeMax !== undefined) {
      if (isMinOrMaxArgument(maybeMax)) {
        max = toMax(maybeMax);
      } else {
        error(`Expected "${maybeMax}" to be a <max> argument, but it's not numeric or "auto" (<min> was supplied as "${min}")`)
        return 1
      }

      // if we got min and max, but something else, err
      if (argv._.length > 3) {
        error(`Invalid number of arguments: expected <min> ("${min}") and [max]`)
        return 1
      }
    } else {
      if (min === AUTO) {
        min = 0;
        max = AUTO;
      } else {
        max = min;
      }
    }

    // NOTE: in the future, we might warn that this will be deprecated
    // for now, we just translate it into all DCs
    dcIdOrMin = "all";
  }

  // extract the dcs
  try {
    dcIds = normalizeRegionsList(dcIdOrMin.split(','))
    debug(`${dcIdOrMin} normalized to ${dcIds.join(',')}`)
  } catch (err) {
    if (err.code === 'INVALID_ID') {
      error(
        `The value "${err.id}" in \`--regions\` is not a valid region or DC identifier`,
        'scale-invalid-dc'
      )
      return 1;
    } else if (err.code === 'INVALID_ALL') {
      error('The region value "all" was used, but it cannot be used alongside other region or dc identifiers')
      return 1;
    } else {
      throw err;
    }
  }

  // convert numeric parameters into actual numbers
  // only if min and max haven't been set above
  if (min === null) {
    if (argv._[2] != null) {
      if (isMinOrMaxArgument(argv._[2])) {
        min = toMin(argv._[2]);
      } else {
        error(`Invalid <min> parameter "${argv._[2]}". A number or "auto" were expected`);
        return 1;
      }

      if (argv._[3] != null) {
        if (isMinOrMaxArgument(argv._[3])) {
          max = toMax(argv._[3]);
        } else {
          error(`Invalid <max> parameter "${argv._[3]}". A number or "auto" were expected`);
          return 1;
        }
      } else {
        if (min === AUTO) {
          max = AUTO;
        } else {
          max = min;
        }
      }
    } else {
      min = 0;
      max = AUTO;
    }
  }

  const {authConfig: { credentials }, config: { sh }} = ctx
  const {token} = credentials.find(item => item.provider === 'sh')
  const { currentTeam } = sh;
  const contextName = getContextName(sh);

  const now = new Now({ apiUrl, token, debug: debugEnabled, currentTeam })

  // resolve the deployment, since we might have been given an alias
  const depFetchStart = Date.now();
  const cancelWait = wait(`Fetching deployment "${id}" in ${chalk.bold(contextName)}`);
  try {
    deployment = await now.findDeployment(id)
    cancelWait();
  } catch (err) {
    cancelWait();
    if (err.status === 404) {
      error(`Failed to find deployment "${id}" in ${chalk.bold(contextName)}`)
      now.close();
      return 1;
    } else {
      // unexpected
      throw err;
    }
  }

  log(`Fetched deployment "${deployment.url}" ${elapsed(Date.now() - depFetchStart)}`);

  if (deployment.type === TYPE_STATIC) {
    error('Scaling rules cannot be set on static deployments');
    now.close();
    return 1;
  }

  if (deployment.state === STATE_ERROR) {
    error('Cannot scale a deployment in the ERROR state');
    now.close();
    return 1;
  }

  const scaleArgs = {}
  for (const dc of dcIds) {
    scaleArgs[dc] = {
      min,
      max
    }
  }
  debug('scale args: ' + JSON.stringify(scaleArgs));

  const cancelScaleWait = wait(`Setting scale rules for ${
    dcIds.map(d => chalk.bold(d)).join(', ')
  } (min: ${chalk.bold(min)}, max: ${chalk.bold(max)})`);

  const startScale = Date.now();

  try {
    await setScale(now, deployment.uid, scaleArgs);
    cancelScaleWait();
  } catch (err) {
    cancelScaleWait();
    if (err.status === 400) {
      switch (err.code) {
        case 'forbidden_min_instances':
          error(`You can't scale to more than ${err.max} min instances with your current plan.`);
          break;
        case 'forbidden_max_instances':
          error(`You can't scale to more than ${err.max} max instances with your current plan.`);
          break;
        case 'wrong_min_max_relation':
          error(`Min number of instances can't be higher than max.`);
          break;
        default:
          throw err;
      }
      return 1;
    } else {
      throw err;
    }
  }

  const successMsg = `${chalk.gray('>')} Scale rules for ${
    dcIds.map(d => chalk.bold(d)).join(', ')
  } (min: ${chalk.bold(min)}, max: ${chalk.bold(max)}) saved ${elapsed(Date.now() - startScale)}`

  if (deployment.type === 'BINARY' || argv['--no-verify']) {
    console.log(successMsg)
    now.close();
    return 0;
  }

  console.log(successMsg)
  const startVerification = Date.now()
  const cancelVerifyWait = waitDcs(scaleArgs, output)
  const cancelExit = onExit(() => {
    cancelVerifyWait();
    log('Verification aborted. Scale settings were saved')
    exit(0);
  });

  try {
    await waitForScale(
      now,
      deployment.uid,
      scaleArgs,
      output,
      {
        timeout: ms(argv['--verify-timeout'] != null ? argv['--verify-timeout'] : '2m'),
        checkInterval: 500,
        onDCScaled(id, instanceCount) {
          cancelVerifyWait(id, instanceCount);
        }
      }
    );
    cancelVerifyWait()
  } catch (err) {
    cancelVerifyWait()
    throw err
  } finally {
    cancelExit();
  }

  success(`Scale state verified ${elapsed(Date.now() - startVerification)}`);

  now.close();
  return 0;
}

// version of wait() that also displays progress
// for all dcs
function waitDcs(scaleArgs, { log }) {
  let cancelMainWait;
  const waitStart = Date.now();
  const remaining = new Set(Object.keys(scaleArgs));
  const renderWait = () => {
    cancelMainWait = wait(`Waiting for instances in ${
      Array.from(remaining).map(id => chalk.bold(id)).join(', ')
    } to match constraints`)
  }
  renderWait();
  return (dcId = null, instanceCount = null) => {
    if (dcId !== null && instanceCount !== null) {
      remaining.delete(dcId);
      cancelMainWait();
      log(`${chalk.cyan(tick)} Verified ${chalk.bold(dcId)} (${instanceCount}) ${elapsed(Date.now() - waitStart)}`);
      renderWait();
    } else {
      cancelMainWait();
    }
  }
}

// invokes the passed function upon process exit
function onExit(fn: Function) {
  let exit = false;

  const onExit_ = () => {
    if (exit) return;
    fn();
    exit = true;
  }

  process.on('SIGTERM', onExit_);
  process.on('SIGINT', onExit_);
  process.on('exit', onExit_);

  return () => {
    process.removeListener('SIGTERM', onExit_);
    process.removeListener('SIGINT', onExit_);
    process.removeListener('exit', onExit_);
  }
}

function setScale(now, deploymentId, scale) {
  return now.fetch(
    `/v3/now/deployments/${encodeURIComponent(deploymentId)}/instances`,
    {
      method: 'PATCH',
      body: scale
    }
  )
}

// waits until the deployment's instances count reflects the intended
// scale that the user is configuring with the command
async function waitForScale(now, deploymentId, intendedScale, { debug }, { timeout = ms('2m'), checkInterval = 500, onDCScaled = null } = {}) {
  const start = Date.now()
  const intendedScaleDcs = new Set(Object.keys(intendedScale));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (start + timeout <= Date.now()) {
      throw new Error('Timeout while verifying instance count (10m)');
    }

    const data = await now.fetch(`/v3/now/deployments/${encodeURIComponent(deploymentId)}/instances?init=1`)

    for (const dc of intendedScaleDcs) {
      const currentScale = data[dc];

      if (!currentScale) {
        debug(`missing data for dc ${dc}`)
        break;
      }

      const instanceCount = data[dc].instances.length;
      const { min, max } = intendedScale[dc];
      if (isInstanceCountBetween(instanceCount, min, max)) {
        if (onDCScaled !== null) {
          onDCScaled(dc, instanceCount);
        }
        intendedScaleDcs.delete(dc);
        debug(`dc "${dc}" match`);
      } else {
        debug(`dc "${dc}" miss. intended: ${min}-${max}. current: ${instanceCount}`);
      }
    }

    if (intendedScaleDcs.size === 0) {
      return;
    }

    await sleep(checkInterval);
  }
}

// whether it's a numeric or "auto"
function isMinOrMaxArgument (v: string) {
  return v === AUTO || isNumeric(v);
}

function isInstanceCountBetween(v: number, min: number, max: number) {
  if (v < min) {
    return false;
  }

  if (v > (max === AUTO ? Infinity : max)) {
    return false;
  }

  return true;
}

// converts "3" to 3, and "auto" to 0
function toMin (v: string) {
  return v === AUTO ? v : Number(v);
}

// converts "3" to 3, and "auto" to "auto"
function toMax (v: string) {
  return v === AUTO ? v : Number(v);
}

// validates whether a string is "numeric", like "3"
function isNumeric (v: string) {
  return /^\d+$/.test(v)
}
