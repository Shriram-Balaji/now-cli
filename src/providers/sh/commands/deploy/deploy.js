//@flow

// Native
const { resolve, basename } = require('path')

// Packages
const Progress = require('progress')
const fs = require('fs-extra')
const ms = require('ms')
const bytes = require('bytes')
const chalk = require('chalk')
const mri = require('mri')
const dotenv = require('dotenv')
const { eraseLines } = require('ansi-escapes')
const { write: copy } = require('clipboardy')
const inquirer = require('inquirer')
const executable = require('executable')
const { tick } = require('../../../../util/output/chars')
const elapsed = require('../../../../util/output/elapsed')
const sleep = require('then-sleep');

// Utilities
const Now = require('../../util')
const isELF = require('../../util/is-elf')
const createOutput = require('../../../../util/output')
const toHumanPath = require('../../../../util/humanize-path')
const { handleError } = require('../../util/error')
const readMetaData = require('../../util/read-metadata')
const checkPath = require('../../util/check-path')
const logo = require('../../../../util/output/logo')
const cmd = require('../../../../util/output/cmd')
const wait = require('../../../../util/output/wait')
const stamp = require('../../../../util/output/stamp')
const promptBool = require('../../../../util/input/prompt-bool')
const promptOptions = require('../../util/prompt-options')
const exit = require('../../../../util/exit')
const { normalizeRegionsList, isValidRegionOrDcId } = require('../../util/dcs')
import getContextName from '../../util/get-context-name'
import getDeploymentEvents from '../../util/deploy/get-deployment-events'
import type { NewDeployment } from '../../util/types'

const mriOpts = {
  string: ['name', 'alias', 'session-affinity', 'regions'],
  boolean: [
    'help',
    'version',
    'debug',
    'force',
    'links',
    'no-clipboard',
    'forward-npm',
    'docker',
    'npm',
    'static',
    'public'
  ],
  alias: {
    env: 'e',
    dotenv: 'E',
    help: 'h',
    debug: 'd',
    version: 'v',
    force: 'f',
    links: 'l',
    public: 'p',
    'no-clipboard': 'C',
    'forward-npm': 'N',
    'session-affinity': 'S',
    name: 'n',
    alias: 'a'
  }
}

const help = () => {
  console.log(`
  ${chalk.bold(`${logo} now`)} [options] <command | path>

  ${chalk.dim('Commands:')}

    ${chalk.dim('Cloud')}

      deploy               [path]      Performs a deployment ${chalk.bold('(default)')}
      ls | list            [app]       List deployments
      rm | remove          [id]        Remove a deployment
      ln | alias           [id] [url]  Configures aliases for deployments
      domains              [name]      Manages your domain names
      certs                [cmd]       Manages your SSL certificates
      secrets              [name]      Manages your secret environment variables
      dns                  [name]      Manages your DNS records
      logs                 [url]       Displays the logs for a deployment
      scale                [args]      Scales the instance count of a deployment
      help                 [cmd]       Displays complete help for [cmd]

    ${chalk.dim('Administrative')}

      billing | cc         [cmd]       Manages your credit cards and billing methods
      upgrade | downgrade  [plan]      Upgrades or downgrades your plan
      teams                [team]      Manages your teams
      switch                           Switches between teams and your account
      login                            Login into your account or creates a new one
      logout                           Logout from your account

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -v, --version                  Output the version number
    -n, --name                     Set the name of the deployment
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline(
    'FILE'
  )}   Path to the local ${'`now.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline(
    'DIR'
  )}    Path to the global ${'`.now`'} directory
    -d, --debug                    Debug mode [off]
    -f, --force                    Force a new deployment even if nothing has changed
    -t ${chalk.underline('TOKEN')}, --token=${chalk.underline(
    'TOKEN'
  )}        Login token
    -l, --links                    Copy symlinks without resolving their target
    -p, --public                   Deployment is public (${chalk.dim(
      '`/_src`'
    )} is exposed) [on for oss, off for premium]
    -e, --env                      Include an env var (e.g.: ${chalk.dim(
      '`-e KEY=value`'
    )}). Can appear many times.
    -E ${chalk.underline('FILE')}, --dotenv=${chalk.underline(
    'FILE'
  )}         Include env vars from .env file. Defaults to '.env'
    -C, --no-clipboard             Do not attempt to copy URL to clipboard
    -N, --forward-npm              Forward login information to install private npm modules
    --session-affinity             Session affinity, \`ip\` or \`random\` (default) to control session affinity
    -T, --team                     Set a custom team scope
    --regions                      Set default regions or DCs to enable the deployment on
    --no-verify                    Skip step of waiting until instance count meets given constraints

  ${chalk.dim(`Enforceable Types (by default, it's detected automatically):`)}

    --npm                          Node.js application
    --docker                       Docker container
    --static                       Static file hosting

  ${chalk.dim('Examples:')}

  ${chalk.gray('–')} Deploy the current directory

    ${chalk.cyan('$ now')}

  ${chalk.gray('–')} Deploy a custom path

    ${chalk.cyan('$ now /usr/src/project')}

  ${chalk.gray('–')} Deploy a GitHub repository

    ${chalk.cyan('$ now user/repo#ref')}

  ${chalk.gray('–')} Deploy with environment variables

    ${chalk.cyan('$ now -e NODE_ENV=production -e SECRET=@mysql-secret')}

  ${chalk.gray('–')} Show the usage information for the sub command ${chalk.dim(
    '`list`'
  )}

    ${chalk.cyan('$ now help list')}
`)
}

let argv
let paths

// Options
let forceNew
let deploymentName
let sessionAffinity
let log
let error
let debug
let note
let debugEnabled
let clipboard
let forwardNpm
let followSymlinks
let wantsPublic
let regions
let noVerify
let apiUrl
let isTTY
let quiet
let alwaysForwardNpm

// If the current deployment is a repo
const gitRepo = {}

const stopDeployment = async msg => {
  handleError(msg)
  await exit(1)
}

// Converts `env` Arrays, Strings and Objects into env Objects.
// `null` empty value means to prompt user for value upon deployment.
// `undefined` empty value means to inherit value from user's env.
const parseEnv = (env, empty) => {
  if (!env) {
    return {}
  }
  if (typeof env === 'string') {
    // a single `--env` arg comes in as a String
    env = [env]
  }
  if (Array.isArray(env)) {
    return env.reduce((o, e) => {
      let key
      let value
      const equalsSign = e.indexOf('=')
      if (equalsSign === -1) {
        key = e
        value = empty
      } else {
        key = e.substr(0, equalsSign)
        value = e.substr(equalsSign + 1)
      }
      o[key] = value
      return o
    }, {})
  }
  // assume it's already an Object
  return env
}

const promptForEnvFields = async list => {
  if (list.length === 0) {
    return {}
  }

  const questions = []

  for (const field of list) {
    questions.push({
      name: field,
      message: field
    })
  }

  // eslint-disable-next-line import/no-unassigned-import
  require('../../../../util/input/patch-inquirer')

  log('Please enter values for the following environment variables:')
  const answers = await inquirer.prompt(questions)

  for (const answer of Object.keys(answers)) {
    const content = answers[answer]

    if (content === '') {
      await stopDeployment(`Enter a value for ${answer}`)
    }
  }

  return answers
}

async function main(ctx: any) {
  argv = mri(ctx.argv.slice(2), mriOpts)

  // very ugly hack – this (now-cli's code) expects that `argv._[0]` is the path
  // we should fix this ASAP
  if (argv._[0] === 'sh') {
    argv._.shift()
  }

  if (argv._[0] === 'deploy') {
    argv._.shift()
  }

  if (argv._.length > 0) {
    // If path is relative: resolve
    // if path is absolute: clear up strange `/` etc
    paths = argv._.map(item => resolve(process.cwd(), item))
  } else {
    paths = [process.cwd()]
  }

  // Options
  forceNew = argv.force
  deploymentName = argv.name
  sessionAffinity = argv['session-affinity']
  debugEnabled = argv.debug
  clipboard = !argv['no-clipboard']
  forwardNpm = argv['forward-npm']
  followSymlinks = !argv.links
  wantsPublic = argv.public
  regions = (argv.regions || '').split(',').map(s => s.trim()).filter(Boolean)
  noVerify = argv['verify'] === false
  apiUrl = ctx.apiUrl
  const output = createOutput({ debug: debugEnabled })
  // https://github.com/facebook/flow/issues/1825
  // $FlowFixMe
  isTTY = process.stdout.isTTY
  quiet = !isTTY
  ;({ log, error, note, debug } = output)

  if (argv.h || argv.help) {
    help()
    await exit(0)
  }

  const { authConfig: { credentials }, config: { sh } } = ctx
  const { token } = credentials.find(item => item.provider === 'sh')
  const contextName = getContextName(sh);
  const config = sh
  
  alwaysForwardNpm = config.forwardNpm

  try {
    return sync({ contextName, output, token, config, showMessage: true })
  } catch (err) {
    await stopDeployment(err)
  }
}

async function sync({ contextName, output, token, config: { currentTeam, user }, showMessage }) {
  return new Promise(async (_resolve, reject) => {
    const deployStamp = stamp()
    const rawPath = argv._[0]

    let meta
    let deployment: NewDeployment | null = null
    let deploymentType
    let isFile
    let atlas = false

    if (paths.length === 1) {
      try {
        const fsData = await fs.lstat(paths[0])

        if (fsData.isFile()) {
          isFile = true
          deploymentType = 'static'
          atlas = await isELF(paths[0]) && executable.checkMode(fsData.mode, fsData.gid, fsData.uid)
        }
      } catch (err) {
        let repo
        let isValidRepo = false

        const { fromGit, isRepoPath, gitPathParts } = require('../../util/git')

        try {
          isValidRepo = isRepoPath(rawPath)
        } catch (_err) {
          if (err.code === 'INVALID_URL') {
            await stopDeployment(_err)
          } else {
            reject(_err)
          }
        }

        if (isValidRepo) {
          const gitParts = gitPathParts(rawPath)
          Object.assign(gitRepo, gitParts)

          const searchMessage = setTimeout(() => {
            log(`Didn't find directory. Searching on ${gitRepo.type}...`)
          }, 500)

          try {
            repo = await fromGit(rawPath, debugEnabled)
          } catch (err) {}

          clearTimeout(searchMessage)
        }

        if (repo) {
          // Tell now which directory to deploy
          paths = [ repo.path ]

          // Set global variable for deleting tmp dir later
          // once the deployment has finished
          Object.assign(gitRepo, repo)
        } else if (isValidRepo) {
          const gitRef = gitRepo.ref ? `with "${chalk.bold(gitRepo.ref)}" ` : ''

          await stopDeployment(`There's no repository named "${chalk.bold(
              gitRepo.main
            )}" ${gitRef}on ${gitRepo.type}`)
        } else {
          error(`The specified directory "${basename(paths[0])}" doesn't exist.`)
          await exit(1)
        }
      }
    } else {
      isFile = false
      deploymentType = 'static'
    }

    const checkers = []

    if (isFile || (!isFile && paths.length === 1)) {
      checkers.push(checkPath(paths[0]))
    } else {
      for (const path of paths) {
        const fsData = await fs.lstat(path)

        if (fsData.isFile()) {
          continue
        }

        checkers.push(checkPath(path))
      }
    }

    try {
      await Promise.all(checkers)
    } catch (err) {
      error(err.message, 'path-not-deployable')
      await exit(1)
    }

    if (!quiet && showMessage) {
      if (gitRepo.main) {
        const gitRef = gitRepo.ref ? ` at "${chalk.bold(gitRepo.ref)}" ` : ''

        log(`Deploying ${gitRepo.type} repository "${chalk.bold(
            gitRepo.main
          )}"${gitRef} under ${chalk.bold(
            (currentTeam && currentTeam.slug) || user.username || user.email
          )}`)
      } else {
        const list = paths
          .map((path, index) => {
            let suffix = ''

            if (paths.length > 1 && index !== paths.length - 1) {
              suffix = index < paths.length - 2 ? ', ' : ' and '
            }

            return chalk.bold(toHumanPath(path)) + suffix
          })
          .join('')

        log(`Deploying ${list} under ${chalk.bold(
            (currentTeam && currentTeam.slug) || user.username || user.email
          )}`)
      }
    }

    if (!isFile && deploymentType !== 'static') {
      if (argv.docker) {
        debug(`Forcing \`deploymentType\` = \`docker\``)
        deploymentType = 'docker'
      } else if (argv.npm) {
        debug(`Forcing \`deploymentType\` = \`npm\``)
        deploymentType = 'npm'
      } else if (argv.static) {
        debug(`Forcing \`deploymentType\` = \`static\``)
        deploymentType = 'static'
      }
    } else if (deploymentType === 'static') {
      debug(`Forcing \`deploymentType\` = \`static\` automatically`)

      meta = {
        name: deploymentName || (isFile
          ? 'file'
          : paths.length === 1 ? basename(paths[0]) : 'files'),
        type: deploymentType,
        pkg: undefined,
        nowConfig: undefined,
        hasNowJson: false,

        // XXX: legacy
        deploymentType,
        sessionAffinity
      }
    }

    if (!meta) {
      ;({
        meta,
        deploymentName,
        deploymentType,
        sessionAffinity
      } = await readMeta(paths[0], deploymentName, deploymentType, sessionAffinity))
    }

    const nowConfig = meta.nowConfig

    let scale
    if (regions.length) {
      // ignore now.json if regions cli option exists
      scale = {}
    } else {
      const _nowConfig = nowConfig || {}
      regions = _nowConfig.regions || []
      scale = _nowConfig.scale || {}
    }

    // get all the region or dc identifiers from the scale settings
    const scaleKeys = Object.keys(scale)

    for (const scaleKey of scaleKeys) {
      if (!isValidRegionOrDcId(scaleKey)) {
        error(
          `The value "${scaleKey}" in \`scale\` settings is not a valid region or DC identifier`,
          'deploy-invalid-dc'
        )
        await exit(1)
      }
    }

    let dcIds = []

    if (regions.length) {
      if (Object.keys(scale).length) {
        error(
          "Can't set both `regions` and `scale` options simultaneously",
          'regions-and-scale-at-once'
        )
        await exit(1)
      }

      try {
        dcIds = normalizeRegionsList(regions)
      } catch (err) {
        if (err.code === 'INVALID_ID') {
          error(
            `The value "${err.id}" in \`--regions\` is not a valid region or DC identifier`,
            'deploy-invalid-dc'
          )
          await exit(1)
        } else if (err.code === 'INVALID_ALL') {
          error('The region value "all" was used, but it cannot be used alongside other region or dc identifiers')
          await exit(1)
        } else {
          throw err
        }
      }

      for (const dcId of dcIds) {
        scale[dcId] = { min: 0, max: 1 }
      }
    }

    const now = new Now({ apiUrl, token, debug: debugEnabled, currentTeam })

    let dotenvConfig
    let dotenvOption

    if (argv.dotenv) {
      dotenvOption = argv.dotenv
    } else if (nowConfig && nowConfig.dotenv) {
      dotenvOption = nowConfig.dotenv
    }

    if (dotenvOption) {
      const dotenvFileName =
        typeof dotenvOption === 'string' ? dotenvOption : '.env'

      try {
        const dotenvFile = await fs.readFile(dotenvFileName)
        dotenvConfig = dotenv.parse(dotenvFile)
      } catch (err) {
        if (err.code === 'ENOENT') {
          error(
            `--dotenv flag is set but ${dotenvFileName} file is missing`,
            'missing-dotenv-target'
          )

          await exit(1)
        } else {
          throw err
        }
      }
    }

    // Merge dotenv config, `env` from now.json, and `--env` / `-e` arguments
    const deploymentEnv = Object.assign(
      {},
      dotenvConfig,
      parseEnv(nowConfig && nowConfig.env, null),
      parseEnv(argv.env, undefined)
    )

    // If there's any envs with `null` then prompt the user for the values
    const askFor = Object.keys(deploymentEnv).filter(
      key => deploymentEnv[key] === null
    )
    Object.assign(deploymentEnv, await promptForEnvFields(askFor))

    let secrets
    const findSecret = async uidOrName => {
      if (!secrets) {
        secrets = await now.listSecrets()
      }

      return secrets.filter(secret => {
        return secret.name === uidOrName || secret.uid === uidOrName
      })
    }

    const env_ = await Promise.all(
      Object.keys(deploymentEnv).map(async key => {
        if (!key) {
          error(
            'Environment variable name is missing',
            'missing-env-key-value'
          )

          await exit(1)
        }

        if (/[^A-z0-9_]/i.test(key)) {
          error(
            `Invalid ${chalk.dim('-e')} key ${chalk.bold(
              `"${chalk.bold(key)}"`
            )}. Only letters, digits and underscores are allowed.`
          )

          await exit(1)
        }

        let val = deploymentEnv[key]

        if (val === undefined) {
          if (key in process.env) {
            log(
              `Reading ${chalk.bold(
                `"${chalk.bold(key)}"`
              )} from your env (as no value was specified)`
            )
            // Escape value if it begins with @
            if (process.env[key] != null) {
              val = process.env[key].replace(/^@/, '\\@')
            }
          } else {
            error(
              `No value specified for env ${chalk.bold(
                `"${chalk.bold(key)}"`
              )} and it was not found in your env.`
            )

            await exit(1)
          }
        }

        if (val[0] === '@') {
          const uidOrName = val.substr(1)
          const _secrets = await findSecret(uidOrName)

          if (_secrets.length === 0) {
            if (uidOrName === '') {
              error(
                `Empty reference provided for env key ${chalk.bold(
                  `"${chalk.bold(key)}"`
                )}`
              )
            } else {
              error(
                `No secret found by uid or name ${chalk.bold(`"${uidOrName}"`)}`,
                'env-no-secret'
              )
            }

            await exit(1)
          } else if (_secrets.length > 1) {
            error(
              `Ambiguous secret ${chalk.bold(
                `"${uidOrName}"`
              )} (matches ${chalk.bold(_secrets.length)} secrets)`
            )

            await exit(1)
          }

          val = { uid: _secrets[0].uid }
        }

        return [key, typeof val === 'string' ? val.replace(/^\\@/, '@') : val]
      })
    )

    const env = {}

    env_.filter(v => Boolean(v)).forEach(([key, val]) => {
      if (key in env) {
          note(`Overriding duplicate env key ${chalk.bold(`"${key}"`)}`)
      }

      env[key] = val
    })

    let syncCount

    try {
      // $FlowFixMe
      const createArgs = Object.assign(
        {
          env,
          followSymlinks,
          forceNew,
          forwardNpm: alwaysForwardNpm || forwardNpm,
          quiet,
          scale,
          wantsPublic,
          sessionAffinity,
          isFile,
          atlas: atlas || (meta.hasNowJson && nowConfig && Boolean(nowConfig.atlas))
        },
        meta
      )

      deployment = await now.create(paths, createArgs)

      if (now.syncFileCount > 0) {
        await new Promise((resolve) => {
          if (now.syncFileCount !== now.fileCount) {
            debug(`Total files ${now.fileCount}, ${now.syncFileCount} changed`)
          }

          const size = bytes(now.syncAmount)
          syncCount = `${now.syncFileCount} file${now.syncFileCount > 1
            ? 's'
            : ''}`
          const bar = new Progress(
            `> Upload [:bar] :percent :etas (${size}) [${syncCount}]`,
            {
              width: 20,
              complete: '=',
              incomplete: '',
              total: now.syncAmount,
              clear: true
            }
          )

          now.upload()

          now.on('upload', ({ names, data }) => {
            const amount = data.length
            debug(`Uploaded: ${names.join(' ')} (${bytes(data.length)})`)

            bar.tick(amount)
          })

          now.on('complete', () => resolve())

          now.on('error', err => {
            error('Upload failed')
            reject(err)
          })
        })

        deployment = await now.create(paths, createArgs)
      }
    } catch (err) {
      if (err.code === 'plan_requires_public') {
        if (!wantsPublic) {
          const who = currentTeam ? 'your team is' : 'you are'

          let proceed
          log(`Your deployment's code and logs will be publicly accessible because ${who} subscribed to the OSS plan.`)

          if (isTTY) {
            proceed = await promptBool('Are you sure you want to proceed?', {
              trailing: eraseLines(1)
            })
          }

          let url = 'https://zeit.co/account/plan'

          if (currentTeam) {
            url = `https://zeit.co/teams/${currentTeam.slug}/settings/plan`
          }

          note(`You can use ${cmd('now --public')} or upgrade your plan (${url}) to skip this prompt`)

          if (!proceed) {
            if (typeof proceed === 'undefined') {
              const message = `If you agree with that, please run again with ${cmd('--public')}.`
              error(message)

              await exit(1)
            } else {
              log('Aborted')
              await exit(0)
            }

            return
          }
        }

        wantsPublic = true

        sync({
          contextName,
          output,
          token,
          config: {
            currentTeam,
            user
          },
          showMessage: false
        })

        return
      }

      debug(`Error: ${err}\n${err.stack}`)

      if (err.keyword === 'additionalProperties' && err.dataPath === '.scale') {
        const { additionalProperty = '' } = err.params || {}
        const message = regions.length
          ? `Invalid regions: ${additionalProperty.slice(0, -1)}`
          : `Invalid DC name for the scale option: ${additionalProperty}`
        error(message)
        await exit(1)
      }

      await stopDeployment(err)
    }

    const { url } = now
    // $FlowFixMe
    const dcs = (deploymentType !== 'static' && deployment.scale)
      ? ` (${chalk.bold(Object.keys(deployment.scale).join(', '))})`
      : ''


    if (isTTY) {
      if (clipboard) {
        try {
          await copy(url)
          log(`${chalk.bold(chalk.cyan(url))} [in clipboard]${dcs} ${deployStamp()}`)
        } catch (err) {
          debug(`Error copying to clipboard: ${err}`)
          log(`${chalk.bold(chalk.cyan(url))} [in clipboard]${dcs} ${deployStamp()}`)
        }
      } else {
        log(`${chalk.bold(chalk.cyan(url))}${dcs} ${deployStamp()}`)
      }
    } else {
      process.stdout.write(url)
    }

    if (!quiet && syncCount) {
      log(`Synced ${syncCount} (${bytes(now.syncAmount)}) ${deployStamp()}`)
    }

    // Show build logs
    if (deploymentType === 'static') {
      if (!quiet) {
        output.log(chalk`{cyan Deployment complete!}`)
      }
      await exit(0)

      // We have to add this check for flow but it will never happen
    } else if (deployment !== null) {

      // If the created deployment is ready it was a deduping and we should exit
      if (deployment.readyState === 'READY') {
        output.success(`Deployment ready`)
        await exit(0)
      } else {
        require('assert')(deployment) // mute linter
        const events = await getDeploymentEvents(now, contextName, now.id, { direction: 'forward', follow: true })
        for await (const event of events) {
          // Stop when the deployment is ready
          if (event.type === 'state-change' && event.payload.value === 'READY') {
            output.log(`Build completed`);
            break
          }

          // Stop then there is an error state
          if (event.type === 'state-change' && event.payload.value === 'ERROR') {
            output.error(`Build failed`);
            await exit(1)
          }

          // For any relevant event we receive, print the result
          if (event.type === 'build-start') {
            output.log('Building…')
          } else if (event.type === 'command') {
            output.log(`▲ ${formatText(event.payload.text)}`)
          } else if (event.type === 'stdout' || event.type === 'stderr') {
            formatText(event.payload.text).split('\n').forEach(v => {
              output.log(`${v.replace(/^> /, '')}`)
            })
          }
        }

        // Wait for scale if we need to and exit
        if (!noVerify) {
          try {
            await waitForScale(output, now, deployment.deploymentId, deployment.scale)
          } catch (error) {
            output.error(`Instance verification timed out (2m)`)
            output.log('Read more: https://err.sh/now-cli/verification-timeout')
            await exit(1)
          }
        }
        output.success(`Deployment ready`)
        await exit(0)
      }
    }
  })
}

// TODO: refactor this funtion to use something similar in alias and scale
async function waitForScale(output, now, deploymentId, scale) {
  const checkInterval = 1000
  const timeout = ms('2m')
  const start = Date.now()
  let remainingMatches = new Set(Object.keys(scale))
  let cancelWait = renderRemainingDCsWait(Object.keys(scale))
  
  while (true) { // eslint-disable-line
    if (start + timeout <= Date.now()) {
      cancelWait()
      throw new Error('Timeout while verifying instance count (10m)');
    }

    // Get the matches for deployment scale args
    const instances = await getDeploymentInstances(now, deploymentId)
    const matches = new Set(await getMatchingScalePresets(scale, instances, matchMinPresets))
    const newMatches = new Set([...remainingMatches].filter(dc => matches.has(dc)))
    remainingMatches = new Set([...remainingMatches].filter(dc => !matches.has(dc)))

    // When there are new matches we print and check if we are done
    if (newMatches.size !== 0) {
      if (cancelWait) {
        cancelWait()
      }

      // Print the new matches that we got
      for (const dc of newMatches) {
        // $FlowFixMe
        output.log(`${chalk.cyan(tick)} Verified ${chalk.bold(dc)} (${instances[dc].instances.length}) ${elapsed(Date.now() - start)}`);
      }  

      // If we are done return, otherwise put the spinner back
      if (remainingMatches.size === 0) {
        return null
      } else {
        cancelWait = renderRemainingDCsWait(Array.from(remainingMatches))
      }
    }

    // Sleep for the given interval until the next poll
    await sleep(checkInterval);
  }
}

// TODO: reuse this function in alias and scale commands
function getMatchingScalePresets(scale, instances, predicate) {
  return Object.keys(scale).reduce((result, dc) => {
    return predicate(scale[dc], instances[dc])
      ? [...result, dc]
      : result
  }, [])
}

function renderRemainingDCsWait(remainingDcs) {
  return wait(`Verifying instances in ${
    remainingDcs.map(id => chalk.bold(id)).join(', ')
  }`)
}

function matchMinPresets(scalePreset, instancesObj) {
  const value = Math.max(1, scalePreset.min)
  return instancesObj.instances.length >= value
}

async function getDeploymentInstances(now, deploymentId) {
  return now.fetch(`/v3/now/deployments/${encodeURIComponent(deploymentId)}/instances?init=1`)
}

async function readMeta(
  _path,
  _deploymentName,
  deploymentType,
  _sessionAffinity
) {
  try {
    const meta = await readMetaData(_path, {
      deploymentType,
      deploymentName: _deploymentName,
      quiet: true,
      sessionAffinity: _sessionAffinity
    })

    if (!deploymentType) {
      deploymentType = meta.type
      debug(`Detected \`deploymentType\` = \`${deploymentType}\``)
    }

    if (!_deploymentName) {
      _deploymentName = meta.name
      debug(`Detected \`deploymentName\` = "${_deploymentName}"`)
    }

    return {
      meta,
      deploymentName: _deploymentName,
      deploymentType,
      sessionAffinity: _sessionAffinity
    }
  } catch (err) {
    if (isTTY && err.code === 'MULTIPLE_MANIFESTS') {
      debug('Multiple manifests found, disambiguating')
      log(
        `Two manifests found. Press [${chalk.bold(
          'n'
        )}] to deploy or re-run with --flag`
      )

      deploymentType = await promptOptions([
        ['npm', `${chalk.bold('package.json')}\t${chalk.gray('   --npm')} `],
        ['docker', `${chalk.bold('Dockerfile')}\t${chalk.gray('--docker')} `]
      ])

      debug(`Selected \`deploymentType\` = "${deploymentType}"`)
      return readMeta(_path, _deploymentName, deploymentType)
    }
    throw err
  }
}

function formatText(text: string): string {
  return text.replace(/\n$/, '').replace(/^\n/, '')
}

module.exports = main
