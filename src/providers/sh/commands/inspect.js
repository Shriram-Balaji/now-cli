// @flow

// Packages
const chalk = require('chalk')
const arg = require('arg')
const table = require('text-table')

// Utilities
const cmd = require('../../../util/output/cmd')
const createOutput = require('../../../util/output')
const Now = require('../util/')
const logo = require('../../../util/output/logo')
const elapsed = require('../../../util/output/elapsed')
const argCommon = require('../util/arg-common')()
const wait = require('../../../util/output/wait')
const { handleError } = require('../util/error')
const strlen = require('../util/strlen')
const getContextName = require('../util/get-context-name')

const STATIC = 'STATIC'

const help = () => {
  console.log(`
  ${chalk.bold(`${logo} now inspect`)} <url>

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline('FILE')}   Path to the local ${'`now.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline('DIR')}    Path to the global ${'`.now`'} directory
    -t ${chalk.bold.underline('TOKEN')}, --token=${chalk.bold.underline('TOKEN')}        Login token
    -d, --debug                    Debug mode [off]
    -T, --team                     Set a custom team scope

  ${chalk.dim('Examples:')}

  ${chalk.gray('–')} Get information about a deployment by its unique URL

    ${chalk.cyan('$ now inspect my-deployment-ji2fjij2.now.sh')}

  ${chalk.gray('-')} Get information about the deployment an alias points to

    ${chalk.cyan('$ now scale my-deployment.now.sh')}
  `)
}

module.exports = async function main (ctx: any): Promise<number> {
  let id
  let deployment
  let argv;

  try {
    argv = arg(ctx.argv.slice(3), {
      ...argCommon
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
  const { print, log, error } = output;

  // extract the first parameter
  id = argv._[0]

  if (argv._.length !== 1) {
    error(`${cmd('now inspect <url>')} expects exactly one argument`)
    help();
    return 1;
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
  } catch (err) {
    cancelWait();
    if (err.status === 404) {
      error(`Failed to find deployment "${id}" in ${chalk.bold(contextName)}`)
      return 1;
    } else if (err.status === 403) {
      error(`No permission to access deployment "${id}" in ${chalk.bold(contextName)}`)
      return 1;
    } else {
      // unexpected
      throw err;
    }
  }

  const [scale, events] = await Promise.all([
    caught(now.fetch(`/v3/now/deployments/${encodeURIComponent(deployment.uid)}/instances`)),
    deployment.type === STATIC ? null : caught(now.fetch(`/v1/now/deployments/${encodeURIComponent(deployment.uid)}/events?types=event`)),
  ])

  cancelWait();
  log(`Fetched deployment "${deployment.url}" in ${chalk.bold(contextName)} ${elapsed(Date.now() - depFetchStart)}`);

  print('\n');
  print(chalk.bold('  Meta\n'))
  print(`    ${chalk.dim('uid')}\t\t${deployment.uid}\n`)
  print(`    ${chalk.dim('name')}\t${deployment.name}\n`)
  print(`    ${chalk.dim('state')}\t${stateString(deployment.state)}\n`)
  print(`    ${chalk.dim('type')}\t${deployment.type}\n`)
  print(`    ${chalk.dim('url')}\t\t${deployment.url}\n`)
  print(`    ${chalk.dim('created')}\t${new Date(deployment.created)} ${elapsed(Date.now() - deployment.created)}\n`)

  print('\n');

  if (deployment.type === STATIC) {
    return 0
  }

  print(chalk.bold('  Scale\n'))

  let exitCode = 0

  if (scale instanceof Error) {
    error(`Scale information unavailable: ${scale}`);
    exitCode = 1;
  } else {
    const dcs = Object.keys(scale)
    const t = [['dc', 'min', 'max', 'current'].map(v => chalk.gray(v))];
    for (const dc of dcs) {
      const { instances } = scale[dc];
      const cfg = deployment.scale[dc] || {};
      t.push([
        dc,
        cfg.min || 0,
        cfg.max || 0,
        instances.length
      ])
    }
    print(table(t, {
      align: ['l', 'c', 'c', 'c'],
      hsep: ' '.repeat(8),
      stringLength: strlen
    }).replace(/^(.*)/gm, '    $1') + '\n');
    print('\n')
  }

  print(chalk.bold('  Events\n'))
  if (events instanceof Error) {
    error(`Events unavailable: ${scale}`);
    exitCode = 1;
  } else if (events) {
    events.forEach((data) => {
      print(`    ${chalk.gray(new Date(data.created).toISOString())} ${data.event} ${
        getEventMetadata(data)
      }\n`);
    })
    print('\n')
  }

  return exitCode;
}

// gets the metadata that should be printed next to
// each event

type Event = {
  event: string,
  payload: any,
  created: number
}

function getEventMetadata({ event, payload }: Event): string {
  if (event === 'state') {
    return chalk.bold(payload.value);
  }

  if (event === 'instance-start' || event === 'instance-stop') {
    if (payload.dc != null) {
      return chalk.green(`(${payload.dc})`);
    }
  }

  return '';
}

// makes sure the promise never rejects, exposing the error
// as the resolved value instead
function caught (p): Promise<any> {
  return new Promise(r => {
    p.then(r).catch(r)
  })
}

// renders the state string
function stateString(s: string): string {
  switch (s) {
    case 'INITIALIZING':
      return chalk.yellow(s);

    case 'ERROR':
      return chalk.red(s);

    case 'READY':
      return s;

    default:
      return chalk.gray('UNKNOWN')
  }
}
