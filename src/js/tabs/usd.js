var util = require('util'),
    Tab = require('../client/tab').Tab;

var UsdTab = function ()
{
  Tab.call(this);
};

util.inherits(UsdTab, Tab);

UsdTab.prototype.tabName = 'usd';
UsdTab.prototype.mainMenu = 'fund';

UsdTab.prototype.angularDeps = Tab.prototype.angularDeps.concat(['qr']);

UsdTab.prototype.generateHtml = function ()
{
  return require('../../jade/tabs/usd.jade')();
};

UsdTab.prototype.extraRoutes = [
  { name: '/usd/:result' }
];

UsdTab.prototype.angular = function (module)
{
  module.controller('UsdCtrl', ['$scope', 'rpId', '$routeParams', '$http', 'rpAuthFlow', 'rpNetwork', 'rpTxQueue', '$location',
    function ($scope, $id, $routeParams, $http, authflow, network, txQueue, $location)
    {
      if (!$id.loginStatus) return $id.goId();

      var issuer = Options.b2rAddress;
      var currency = 'USD';
      var trustAmount = '100000000000';

      /**
       * Decide whether we want to show the form
       * (Only show if the user has been KYCd)
       */
      var checkAttestation = function(){
        $scope.options = {
          url         : $scope.userBlob.url,
          auth_secret : $scope.userBlob.data.auth_secret,
          blob_id     : $scope.userBlob.id,
          type        : 'profile',
          full        : true
        };

        authflow.getAttestationSummary($scope.options, function(err, resp) {
          if (err) {
            console.log('Error while getting attestation', err);
            $scope.error = 'Something went wrong, please contact SnapSwap support.';
            return;
          }

          if (resp && resp.decoded && resp.decoded.payload && !resp.decoded.payload.profile_verified) {
            $scope.mode = 'noKyc';
            return;
          }

          $scope.attestation = resp.attestation;
          $scope.mode = 'step1';
        });
      };

      // If blob is already loaded
      if ($scope.userBlob.id) {
        checkAttestation();
      }

      // If not, then wait until it's there
      $scope.$on('$blobUpdate', checkAttestation);

      //$scope.mode = 'step1';
      $scope.step1 = function() {
        $scope.mode = 'step1';
        $location.path('/usd');
      };

      /**
       * Create the Snapswap profile and get the quote
       */

      // Create a SnapSwap account
      $scope.createAccount = function(callback) {
        $http({
          method: 'POST',
          data: {
            domain: 'snapswap.us',
            email: $scope.userBlob.data.email,
            rippleAddress: $id.account,
            trustTxBlob: 'anystring',
            usernameProposal: $id.account, // TODO use ripple name when applicable
            data: {
              source: 'https://id.ripple.com',
              jwt: $scope.attestation
            }
          },
          url: Options.snapswapApi + '/ripple'
        })
        .success(function(){
          callback();
        })
        .error(function(err){
          console.log('Error while creating a SnapSwap account',err);
          callback(err);
        });
      };

      // Get the quote
      $scope.getQuote = function() {
        $scope.error = '';
        $scope.calculating = true;
        $scope.mode = 'step2';

        $http({
          method: 'GET',
          data: {
            amount: Number($scope.usdAmount)
          },
          url: Options.snapswapApi + '/ripple/' + $id.account + '/balance/USD/deposit/instantKnox?amount=' + $scope.usdAmount
        })
        .success(function(data){
          $scope.inProcess = false;

          $scope.fee = data.fee.toFixed(2);
          $scope.total = data.total.toFixed(2);

          $scope.calculating = false;
        })
        .error(function(err){
          console.log('Error while getting the quote', err);

          // In process
          $scope.inProcess = false;

          if (err.type === 'http://snapswap.vc/api/v1/errors/override-not-allowed') {
            $scope.inProcess = true;
          }
          else if (err.title === 'Not Found') {
            // Create account if it doesn't exist yet
            $scope.createAccount(function(err){
              if (err) {
                $scope.error = 'Something went wrong, please contact SnapSwap support.';
                $scope.calculating = false;
                return;
              }

              $scope.getQuote();
            });

            return;
          }

          $scope.error = err.detail;
          $scope.calculating = false;
        });
      };

      /**
       * Transaction confirmed, show the deposit widget
       */
      $scope.prepareTrust = function() {
        // Is there an existing trust line?
        if(existingTrustLine = $scope.lines[issuer + currency]) {
          // Is the trust limit enough?
          if(existingTrustLine.limit.to_number() >= trustAmount)
          // We're good with the existing trust line
            return;
        }

        // Is there an existing trustTx in queue?
        // (Does this really belong here? maybe just move it to txqueue.js?)
        var noNeed;
        _.each(
          // Find all trust transactions in queue
          _.findWhere($scope.userBlob.data.txQueue, {type: "TrustSet"}),
          function(elm,index,txInQueue){
            // Does this fulfil our needs?
            noNeed = txInQueue && txInQueue.details.currency === currency
            && txInQueue.details.issuer === issuer
            && txInQueue.details.value >= trustAmount
          }
        );

        // We already have the necessary trustTx waiting in line.
        if (noNeed) return;

        // Ok, looks like we need to set a trust line
        var tx = network.remote.transaction();
        tx.rippleLineSet($id.account, trustAmount + '/' + currency + '/' + issuer);
        tx.setFlags('NoRipple');

        // txQueue please set the trust line asap.
        txQueue.addTransaction(tx);
      };

      $scope.confirm = function() {
        // Prepare the trustline
        $scope.prepareTrust();

        // Get the knox link
        $http({
          method: 'POST',
          data: {
            amount: Number($scope.usdAmount),
            // TODO have working urls
            success: location.protocol + '//' + Options.domain + '/usd/success',
            cancel: location.protocol + '//' + Options.domain + '/usd/cancel',
            failure: location.protocol + '//' + Options.domain + '/usd/failure'
          },
          url: Options.snapswapApi + '/ripple/' + $id.account + '/balance/USD/deposit/instantKnox'
        }).success(function(data){
          // Add the selected bank swift code
          $scope.iframeUrl = data.redirectUrl + '&swift_code=' + $scope.bank;

          $('#knoxFrame').attr('src',$scope.iframeUrl);

          $scope.mode = 'step3';
        });
      };

      /**
       * Manually cancelling the deposit
       */
      $scope.cancel = function() {
        $http({
          method: 'DELETE',
          url: snapswapApiUrl + '/ripple/' + $id.account + '/processing/instantKnox'
        }).success(function(data, status, headers, config){
          $scope.mode = 'step1';
        });
      }
    }])
};

module.exports = UsdTab;