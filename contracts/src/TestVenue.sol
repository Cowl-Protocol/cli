// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// The testnet trade venue.
///
/// Robinhood Chain testnet has no DEX, and the trade adapter needs one to
/// develop against. These four contracts stand in for the Uniswap V3 stack the
/// mainnet runs: the router and quoter expose the exact V3 interface subset the
/// adapter will call — `exactOutputSingle` and `quoteExactOutputSingle`, same
/// structs, same signatures — so pointing the adapter at the real router later
/// is an address change, not a code change.
///
/// The price is a fixed rate instead of a tick curve. The adapter's job —
/// atomically unshield, swap an exact output, re-shield — does not depend on
/// AMM internals, and a deterministic price makes its tests exact.

interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}

/// The V3 router subset the trade adapter targets. Signature-identical to
/// Uniswap's ISwapRouter so the adapter recompiles against mainnet unchanged.
interface ISwapRouter {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);
}

/// The V3 quoter subset, matching Uniswap's IQuoterV2.
interface IQuoterV2 {
    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactOutputSingle(QuoteExactOutputSingleParams calldata params)
        external
        returns (
            uint256 amountIn,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}

/// WETH9-compatible wrapped ether: deposit, withdraw, plain ERC-20.
contract TestWETH {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        balanceOf[msg.sender] -= wad;
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "WETH: send failed");
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal returns (bool) {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

/// A test Global Dollar: six decimals like the real one, open mint so the
/// testnet needs no faucet operator.
contract TestUSDG {
    string public constant name = "Global Dollar";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal returns (bool) {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

/// Fixed-rate WETH/USDG router with the V3 exactOutputSingle surface. Holds its
/// own inventory of both sides; anyone may top it up, the owner sets the rate.
contract TestSwapRouter is ISwapRouter {
    address public immutable weth;
    address public immutable usdg;
    address public owner;

    /// USDG (6 decimals) per one WETH (1e18). 3000_000000 = 3000 USDG/ETH.
    uint256 public usdgPerWeth;

    error WrongPair();
    error Expired();
    error TooMuchRequested();
    error NotOwner();

    constructor(address _weth, address _usdg, uint256 _usdgPerWeth) {
        weth = _weth;
        usdg = _usdg;
        usdgPerWeth = _usdgPerWeth;
        owner = msg.sender;
    }

    function setRate(uint256 _usdgPerWeth) external {
        if (msg.sender != owner) revert NotOwner();
        usdgPerWeth = _usdgPerWeth;
    }

    /// amountIn owed for an exact amountOut, rounded against the trader.
    function amountInFor(address tokenIn, address tokenOut, uint256 amountOut) public view returns (uint256) {
        if (tokenIn == weth && tokenOut == usdg) {
            return (amountOut * 1e18 + usdgPerWeth - 1) / usdgPerWeth;
        }
        if (tokenIn == usdg && tokenOut == weth) {
            return (amountOut * usdgPerWeth + 1e18 - 1) / 1e18;
        }
        revert WrongPair();
    }

    function exactOutputSingle(ExactOutputSingleParams calldata p) external payable returns (uint256 amountIn) {
        if (block.timestamp > p.deadline) revert Expired();
        amountIn = amountInFor(p.tokenIn, p.tokenOut, p.amountOut);
        if (amountIn > p.amountInMaximum) revert TooMuchRequested();
        require(IERC20Minimal(p.tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        require(IERC20Minimal(p.tokenOut).transfer(p.recipient, p.amountOut), "pay failed");
    }
}

/// Quoter over the router's rate, shaped like Uniswap's QuoterV2.
contract TestQuoterV2 is IQuoterV2 {
    TestSwapRouter public immutable router;

    constructor(TestSwapRouter _router) {
        router = _router;
    }

    function quoteExactOutputSingle(QuoteExactOutputSingleParams calldata p)
        external
        view
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        amountIn = router.amountInFor(p.tokenIn, p.tokenOut, p.amount);
        return (amountIn, 0, 0, 0);
    }
}
