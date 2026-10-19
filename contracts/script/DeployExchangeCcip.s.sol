// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AssetExchange, IPriceFeed, ISyntheticToken} from "../src/AssetExchange.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {CrossChainToken} from "@chainlink/contracts-ccip/contracts/tokens/CrossChainToken.sol";
import {BaseERC20} from "@chainlink/contracts-ccip/contracts/tokens/BaseERC20.sol";
import {BurnMintTokenPool} from "@chainlink/contracts-ccip/contracts/pools/BurnMintTokenPool.sol";
import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

/*
 * The exchange's synthetic tokens as CCIP cross-chain tokens (CCT), burn & mint,
 * between Ethereum Sepolia (where the exchange, its reserve and the Data Feeds
 * live) and Base Sepolia. Three scripts, run in this order:
 *
 *   1. DeployExchangeSepolia  on Sepolia       tokens, exchange, reserve, pools, registry
 *   2. DeployCcipRemote       on Base Sepolia  tokens, pools, registry
 *   3. ConnectPools           on EACH chain    tells each pool its remote pool and token
 *
 * Every address below was read from Chainlink's CCIP directory data and then
 * checked on chain (typeAndVersion, isChainSupported) on 2026-10-17. The lane
 * runs CCIP 2.0 on/off-ramps; the pools are the 2.0 BurnMintTokenPool.
 *
 * Sepolia now prices contract creation far above forge's local EVM: broadcast
 * with --skip-simulation --slow (RUNBOOK, "Sepolia changed under forge's gas
 * estimate").
 */

interface IRegistryModuleOwnerCustom {
    function registerAdminViaGetCCIPAdmin(address token) external;
}

interface ITokenAdminRegistry {
    function acceptAdminRole(address localToken) external;
    function setPool(address localToken, address pool) external;
}

/// Shared by both chains: a token, its pool, and the token's CCIP registration.
abstract contract CctSteps is Script {
    function _token(string memory name, string memory symbol, address admin) internal returns (CrossChainToken) {
        return new CrossChainToken(
            BaseERC20.ConstructorParams({
                name: name,
                symbol: symbol,
                maxSupply: 0, // uncapped: supply follows the reserve's trades
                preMint: 0,
                preMintRecipient: address(0),
                decimals: 18,
                ccipAdmin: admin
            }),
            admin, // may grant mint/burn roles
            admin // owner
        );
    }

    /// Pool, its mint/burn roles, and the registry: claim admin, accept, point at the pool.
    function _poolAndRegister(CrossChainToken token, address rmnProxy, address router, address registryModule, address tokenAdminRegistry)
        internal
        returns (BurnMintTokenPool pool)
    {
        pool = new BurnMintTokenPool(IBurnMintERC20(address(token)), 18, address(0), rmnProxy, router);
        token.grantMintAndBurnRoles(address(pool));
        IRegistryModuleOwnerCustom(registryModule).registerAdminViaGetCCIPAdmin(address(token));
        ITokenAdminRegistry(tokenAdminRegistry).acceptAdminRole(address(token));
        ITokenAdminRegistry(tokenAdminRegistry).setPool(address(token), address(pool));
    }
}

/**
 * Sepolia. Required env: DEPLOYER_PK, TOKEN (MockUSDC), FORWARDER, WORKFLOW_NAME,
 * WORKFLOW_AUTHOR. Optional: RESERVE (mUSDC, 6 decimals; default 10,000).
 */
contract DeployExchangeSepolia is CctSteps {
    // Feeds, measured before listing (RUNBOOK, "The asset exchange").
    address constant XAU_FEED = 0xC5981F461d74c46eB4b0CF3f4Ec79f025573B0Ea;
    address constant CSPX_FEED = 0x4b531A318B0e44B549F3b2f824721b3D0d51930A;

    address constant ROUTER = 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59;
    address constant RMN_PROXY = 0xba3f6251de62dED61Ff98590cB2fDf6871FbB991;
    address constant REGISTRY_MODULE = 0xa3c796d480638d7476792230da1E2ADa86e031b0;
    address constant TOKEN_ADMIN_REGISTRY = 0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address me = vm.addr(pk);
        address usdc = vm.envAddress("TOKEN");
        uint256 reserve = vm.envOr("RESERVE", uint256(10_000e6));

        vm.startBroadcast(pk);
        CrossChainToken sXAU = _token("Synthetic Gold", "sXAU", me);
        CrossChainToken sCSPX = _token("Synthetic S&P 500 ETF", "sCSPX", me);

        AssetExchange ex = new AssetExchange(IERC20(usdc), vm.envAddress("FORWARDER"), ROUTER);
        // Author before name: a name with no author makes onReport revert.
        ex.setExpectedAuthor(vm.envAddress("WORKFLOW_AUTHOR"));
        ex.setExpectedWorkflowName(vm.envString("WORKFLOW_NAME"));
        sXAU.grantMintAndBurnRoles(address(ex));
        sCSPX.grantMintAndBurnRoles(address(ex));
        ex.listAsset("XAU", IPriceFeed(XAU_FEED), ISyntheticToken(address(sXAU)));
        ex.listAsset("CSPX", IPriceFeed(CSPX_FEED), ISyntheticToken(address(sCSPX)));

        MockUSDC(usdc).mint(me, reserve);
        IERC20(usdc).approve(address(ex), reserve);
        ex.fundReserve(reserve);

        BurnMintTokenPool pXAU = _poolAndRegister(sXAU, RMN_PROXY, ROUTER, REGISTRY_MODULE, TOKEN_ADMIN_REGISTRY);
        BurnMintTokenPool pCSPX = _poolAndRegister(sCSPX, RMN_PROXY, ROUTER, REGISTRY_MODULE, TOKEN_ADMIN_REGISTRY);
        vm.stopBroadcast();

        console2.log("ASSET_EXCHANGE ", address(ex));
        console2.log("sXAU           ", address(sXAU));
        console2.log("sCSPX          ", address(sCSPX));
        console2.log("POOL_sXAU      ", address(pXAU));
        console2.log("POOL_sCSPX     ", address(pCSPX));
        console2.logBytes10(ex.getExpectedWorkflowName());
    }
}

/// Base Sepolia. Required env: DEPLOYER_PK.
contract DeployCcipRemote is CctSteps {
    address constant ROUTER = 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93;
    address constant RMN_PROXY = 0x99360767a4705f68CcCb9533195B761648d6d807;
    address constant REGISTRY_MODULE = 0x176ae8C6C11DD2c031B924CE1A0A43188035f3f6;
    address constant TOKEN_ADMIN_REGISTRY = 0x736D0bBb318c1B27Ff686cd19804094E66250e17;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address me = vm.addr(pk);

        vm.startBroadcast(pk);
        // Same names and symbols as on Sepolia: one asset, two chains.
        CrossChainToken sXAU = _token("Synthetic Gold", "sXAU", me);
        CrossChainToken sCSPX = _token("Synthetic S&P 500 ETF", "sCSPX", me);
        BurnMintTokenPool pXAU = _poolAndRegister(sXAU, RMN_PROXY, ROUTER, REGISTRY_MODULE, TOKEN_ADMIN_REGISTRY);
        BurnMintTokenPool pCSPX = _poolAndRegister(sCSPX, RMN_PROXY, ROUTER, REGISTRY_MODULE, TOKEN_ADMIN_REGISTRY);
        vm.stopBroadcast();

        console2.log("BASE_sXAU      ", address(sXAU));
        console2.log("BASE_sCSPX     ", address(sCSPX));
        console2.log("BASE_POOL_sXAU ", address(pXAU));
        console2.log("BASE_POOL_sCSPX", address(pCSPX));
    }
}

/**
 * Run on each chain once both sides exist. Required env: DEPLOYER_PK,
 * REMOTE_SELECTOR, and four addresses: LOCAL_POOL_XAU, LOCAL_POOL_CSPX,
 * REMOTE_POOL_XAU, REMOTE_POOL_CSPX, REMOTE_TOKEN_XAU, REMOTE_TOKEN_CSPX.
 * Rate limits are off: test tokens on a testnet, and a limit the demo trips
 * would look exactly like a broken bridge.
 */
contract ConnectPools is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        uint64 remote = uint64(vm.envUint("REMOTE_SELECTOR"));

        vm.startBroadcast(pk);
        _connect(vm.envAddress("LOCAL_POOL_XAU"), remote, vm.envAddress("REMOTE_POOL_XAU"), vm.envAddress("REMOTE_TOKEN_XAU"));
        _connect(vm.envAddress("LOCAL_POOL_CSPX"), remote, vm.envAddress("REMOTE_POOL_CSPX"), vm.envAddress("REMOTE_TOKEN_CSPX"));
        vm.stopBroadcast();
    }

    function _connect(address localPool, uint64 remoteSelector, address remotePool, address remoteToken) internal {
        bytes[] memory pools = new bytes[](1);
        pools[0] = abi.encode(remotePool);
        TokenPool.ChainUpdate[] memory add = new TokenPool.ChainUpdate[](1);
        add[0] = TokenPool.ChainUpdate({
            remoteChainSelector: remoteSelector,
            remotePoolAddresses: pools,
            remoteTokenAddress: abi.encode(remoteToken),
            outboundRateLimiterConfig: RateLimiter.Config({isEnabled: false, capacity: 0, rate: 0}),
            inboundRateLimiterConfig: RateLimiter.Config({isEnabled: false, capacity: 0, rate: 0})
        });
        TokenPool(localPool).applyChainUpdates(new uint64[](0), add);
        console2.log("connected", localPool, "->", remotePool);
    }
}

/**
 * Sepolia, 2026-10-19: a new exchange on the SAME tokens, able to take a sale
 * that arrives over CCIP (AssetExchange.ccipReceive). The tokens are separate
 * contracts since the CCT rebuild, so balances on both chains carry over; the
 * old exchange loses its mint and burn roles, so it can no longer issue or
 * take back a token. It had no pending orders when this ran.
 *
 * Required env: DEPLOYER_PK, TOKEN (MockUSDC), FORWARDER, WORKFLOW_NAME,
 * WORKFLOW_AUTHOR, OLD_EXCHANGE. Optional: RESERVE (default 10,000 mUSDC).
 */
contract DeployExchangeV3 is Script {
    address constant ROUTER = 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59;
    uint64 constant BASE_SEPOLIA = 10344971235874465080;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address me = vm.addr(pk);
        address usdc = vm.envAddress("TOKEN");
        AssetExchange old = AssetExchange(vm.envAddress("OLD_EXCHANGE"));
        uint256 reserve = vm.envOr("RESERVE", uint256(10_000e6));
        require(old.pendingOrderIds().length == 0, "old exchange still has pending orders");

        vm.startBroadcast(pk);
        AssetExchange ex = new AssetExchange(IERC20(usdc), vm.envAddress("FORWARDER"), ROUTER);
        // Author before name: a name with no author makes onReport revert.
        ex.setExpectedAuthor(vm.envAddress("WORKFLOW_AUTHOR"));
        ex.setExpectedWorkflowName(vm.envString("WORKFLOW_NAME"));
        ex.setCcipSource(BASE_SEPOLIA, true);

        for (uint32 i; i < old.assetCount(); i++) {
            (string memory symbol, address feed, address token,,) = old.asset(i);
            CrossChainToken t = CrossChainToken(token);
            t.grantMintAndBurnRoles(address(ex));
            t.revokeRole(t.MINTER_ROLE(), address(old));
            t.revokeRole(t.BURNER_ROLE(), address(old));
            ex.listAsset(symbol, IPriceFeed(feed), ISyntheticToken(token));
        }

        MockUSDC(usdc).mint(me, reserve);
        IERC20(usdc).approve(address(ex), reserve);
        ex.fundReserve(reserve);
        vm.stopBroadcast();

        console2.log("ASSET_EXCHANGE ", address(ex));
        console2.logBytes10(ex.getExpectedWorkflowName());
    }
}
