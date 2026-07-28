// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// Tokens that report failure the legal-but-hostile way: by returning `false`
/// instead of reverting. A caller that drops the return value treats the failure
/// as a success and carries on.
///
/// The venue mocks in TestVenue.sol always return `true`, which is why the
/// adapter's unchecked returns went unnoticed by 62 passing tests until a static
/// scan pointed at them. These two exist to make that class of failure reachable.
///
/// Both are shaped for `vm.etch`, so they can stand in at whatever address a
/// proof fixture already names.

/// USDG-shaped: a working ERC-20 whose `approve` always fails quietly. Used to
/// reach the adapter's shield-leg approval, which runs after the router has
/// already delivered the output.
contract SilentFailApproveToken {
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    /// The whole point of this mock.
    function approve(address, uint256) external pure returns (bool) {
        return false;
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

/// WETH-shaped: wrapping works, approving does not. Used to reach the adapter's
/// input-leg approval, the first thing it does after unshielding.
contract SilentFailApproveWETH {
    mapping(address => uint256) public balanceOf;

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 wad) external {
        balanceOf[msg.sender] -= wad;
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "WETH: send failed");
    }

    /// The whole point of this mock.
    function approve(address, uint256) external pure returns (bool) {
        return false;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
