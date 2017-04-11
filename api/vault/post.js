'use strict';

var self = post;
module.exports = self;

var async = require('async');
var _ = require('underscore');
var path = require('path');
var fs = require('fs');
var readline = require('readline');
var spawn = require('child_process').spawn;
var envHandler = require('../../common/envHandler.js');

function post(req, res) {
  var bag = {
    reqQuery: req.query,
    resBody: [],
    params: {},
    component: 'vault',
    tmpScript: '/tmp/vault.sh'
  };

  bag.who = util.format('vault|%s', self.name);
  logger.info(bag.who, 'Starting');

  async.series([
      _checkInputParams.bind(null, bag),
      _get.bind(null, bag),
      _generateInitializeEnvs.bind(null, bag),
      _generateInitializeScript.bind(null, bag),
      _writeScriptToFile.bind(null, bag),
      _initializeVault.bind(null, bag),
      _getUnsealKeys.bind(null, bag),
      _getVaultRootToken.bind(null, bag),
      _post.bind(null, bag),
      _updateVaultUrl.bind(null, bag)
    ],
    function (err) {
      logger.info(bag.who, 'Completed');
      if (err)
        return respondWithError(res, err);

      //TODO: remove tmp file
      sendJSONResponse(res, bag.resBody);
    }
  );
}

function _checkInputParams(bag, next) {
  var who = bag.who + '|' + _checkInputParams.name;
  logger.verbose(who, 'Inside');

  return next();
}

function _get(bag, next) {
  var who = bag.who + '|' + _get.name;
  logger.verbose(who, 'Inside');

  var query = util.format('SELECT %s from "systemConfigs"', bag.component);
  global.config.client.query(query,
    function (err, systemConfigs) {
      if (err)
        return next(
          new ActErr(who, ActErr.DataNotFound, err)
        );

      if (!_.isEmpty(systemConfigs.rows) &&
        !_.isEmpty(systemConfigs.rows[0].vault)) {
        logger.debug('Found vault configuration');

        bag.config = systemConfigs.rows[0].vault;
        bag.config = JSON.parse(bag.config);

      } else {
        return next(
          new ActErr(who, ActErr.DataNotFound,
            'No vault configuration in database')
        );
      }

      return next();
    }
  );
}

function _generateInitializeEnvs(bag, next) {
  var who = bag.who + '|' + _generateInitializeEnvs.name;
  logger.verbose(who, 'Inside');

  bag.scriptEnvs = {
    'RUNTIME_DIR': global.config.runtimeDir,
    'CONFIG_DIR': global.config.configDir,
    'SCRIPTS_DIR': global.config.scriptsDir,
    'IS_INITIALIZED': bag.config.isInitialized,
    'IS_INSTALLED': bag.config.isInstalled,
    'DBUSERNAME': global.config.dbUsername,
    'DBPASSWORD': global.config.dbPassword,
    'DBHOST': global.config.dbHost,
    'DBPORT': global.config.dbPort,
    'DBNAME': global.config.dbName,
    'VAULT_HOST': global.config.admiralIP,
    'VAULT_PORT': bag.config.port
  };

  return next();
}

function _generateInitializeScript(bag, next) {
  var who = bag.who + '|' + _generateInitializeScript.name;
  logger.verbose(who, 'Inside');

  //attach header
  var fileName = '../../lib/_logger.sh';
  var headerScript = '';
  headerScript = headerScript.concat(__applyTemplate(fileName, bag.params));

  var initializeScript = headerScript;
  fileName = '../../common/scripts/docker/installVault.sh';
  initializeScript = headerScript.concat(__applyTemplate(fileName, bag.params));

  bag.script = initializeScript;
  return next();
}

function _writeScriptToFile(bag, next) {
  var who = bag.who + '|' + _writeScriptToFile.name;
  logger.debug(who, 'Inside');

  fs.writeFile(bag.tmpScript,
    bag.script,
    function (err) {
      if (err) {
        var msg = util.format('%s, Failed with err:%s', who, err);
        return next(
          new ActErr(
            who, ActErr.OperationFailed, msg)
        );
      }
      fs.chmodSync(bag.tmpScript, '755');
      return next();
    }
  );
}


function _initializeVault(bag, next) {
  var who = bag.who + '|' + _initializeVault.name;
  logger.verbose(who, 'Inside');

  var exec = spawn('/bin/bash',
    ['-c', bag.tmpScript],
    {
      env: bag.scriptEnvs
    }
  );

  exec.stdout.on('data',
    function (data)  {
      console.log(data.toString());
    }
  );

  exec.stderr.on('data',
    function (data)  {
      console.log(data.toString());
    }
  );

  exec.on('close',
    function (exitCode)  {
      return next(exitCode);
    }
  );
}

function _getUnsealKeys(bag, next) {
  var who = bag.who + '|' + _getUnsealKeys.name;
  logger.verbose(who, 'Inside');

  var keyIndex = 1;
  var unsealKeysFile = path.join(
    global.config.configDir, '/vault/scripts/keys.txt');

  var filereader = readline.createInterface({
    input: fs.createReadStream(unsealKeysFile),
    console: false
  });

  filereader.on('line',
    function (line) {
      // this is the format in which unseal keys are stored
      var keyString = util.format('Unseal Key %s:', keyIndex);
      if (!_.isEmpty(line) && line.indexOf(keyString) >= 0) {
        var value = line.split(' ')[3];
        var keyNameInConfig = 'unsealKey' + keyIndex;

        // set the unseal key in config object
        bag.config[keyNameInConfig] = value;

        // parse next key
        keyIndex ++;
      }
    }
  );

  filereader.on('close',
    function () {
      return next(null);
    }
  );
}

function _getVaultRootToken(bag, next) {
  var who = bag.who + '|' + _getVaultRootToken.name;
  logger.verbose(who, 'Inside');

  envHandler.get('VAULT_TOKEN',
    function (err, value) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed, err)
        );

      if (_.isEmpty(value))
        return next(
          new ActErr(who, ActErr.DataNotFound,
            'empty VAULT_TOKEN in admiral.env')
        );

      bag.config.rootToken = value;
      return next();
    }
  );
}

function _post(bag, next) {
  var who = bag.who + '|' + _post.name;
  logger.verbose(who, 'Inside');

  var update = bag.config;
  bag.config.isInstalled = true;
  bag.config.isInitialized = true;

  var query = util.format('UPDATE "systemConfigs" set vault=\'%s\';',
    JSON.stringify(update));

  global.config.client.query(query,
    function (err, response) {
      if (err)
        return next(
          new ActErr(who, ActErr.DataNotFound, err)
        );

      if (response.rowCount === 1) {
        logger.debug('Successfully added default value for vault server');
        bag.resBody = update;
      } else {
        logger.warn('Failed to set default vault server value');
      }

      return next();
    }
  );
}

function _updateVaultUrl(bag, next) {
  var who = bag.who + '|' +  _updateVaultUrl.name;
  logger.verbose(who, 'Inside');

  var query = util.format('UPDATE "systemConfigs" set "vaultUrl"=\'%s\';',
    bag.config.address);

  global.config.client.query(query,
    function (err, response) {
      if (err)
        return next(
          new ActErr(who, ActErr.DataNotFound, err)
        );

      if (response.rowCount === 1) {
        logger.debug('Successfully added default value for vault url');
      } else {
        logger.warn('Failed to set default vault url');
      }

      return next();
    }
  );
}

//local function to apply vars to template
function __applyTemplate(fileName, dataObj) {
  var filePath = path.join(__dirname, fileName);
  var fileContent = fs.readFileSync(filePath).toString();
  var template = _.template(fileContent);

  return template({obj: dataObj});
}
