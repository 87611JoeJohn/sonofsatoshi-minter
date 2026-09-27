// SPDX-License-Identifier: AGPL-3.0-only
// SonOfSatoshi Minter: the collection contract for Ethereum and Base.
//
// One contract per collection. Plain ERC-721 (OpenZeppelin 5.6.1) plus:
//   - a fixed maximum supply, set at deploy and never changeable
//   - owner-only minting in numbered batches (1, 2, 3 …); each batch names the number it expects to start at, so a
//     repeated or replayed mint transaction can never mint extra pieces
//   - token links = base link + id + ".json"; the base can be re-pointed until the owner freezes it forever
//   - ERC-2981 royalties (max 30%), ERC-4906 refresh notices for marketplaces, ERC-7572 contractURI for the collection card
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract SonOfSatoshiCollection is ERC721, ERC2981, Ownable, IERC4906 {
    uint96 public constant MAX_ROYALTY_BPS = 3000;

    uint256 public immutable maxSupply;
    uint256 public totalMinted;
    bool public metadataFrozen;
    string private _base;

    error SoldOut();
    error WrongStart(uint256 expected, uint256 actual);
    error BadCount();
    error MetadataIsFrozen();
    error RoyaltyTooHigh();

    event MetadataFrozen(string baseURI);
    event ContractURIUpdated();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        string memory baseURI_,
        address owner_,
        address royaltyReceiver,
        uint96 royaltyBps
    ) ERC721(name_, symbol_) Ownable(owner_) {
        if (maxSupply_ == 0) revert BadCount();
        maxSupply = maxSupply_;
        _base = baseURI_;
        _royalty(royaltyReceiver, royaltyBps);
    }

    // ---- minting ----
    /// Mints `count` pieces to `to`, numbered from totalMinted + 1. `start` must equal that number.
    function mintBatch(address to, uint256 count, uint256 start) external onlyOwner {
        uint256 minted = totalMinted;
        if (start != minted + 1) revert WrongStart(minted + 1, start);
        if (count == 0) revert BadCount();
        if (count > maxSupply - minted) revert SoldOut();
        totalMinted = minted + count;
        for (uint256 i = 0; i < count; ++i) {
            _mint(to, start + i);
        }
    }

    // ---- links ----
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_base, Strings.toString(tokenId), ".json");
    }

    function baseURI() external view returns (string memory) {
        return _base;
    }

    /// The collection card (name, description, picture) marketplaces show.
    function contractURI() external view returns (string memory) {
        return string.concat(_base, "collection.json");
    }

    function setBaseURI(string calldata newBase) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        _base = newBase;
        emit BatchMetadataUpdate(1, maxSupply);
        emit ContractURIUpdated();
    }

    /// Ask marketplaces to re-read every piece (for example after the files behind the same link changed).
    function refreshMetadata() external onlyOwner {
        emit BatchMetadataUpdate(1, maxSupply);
    }

    /// Permanent: after this, no link can ever change again.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen(_base);
    }

    // ---- royalty ----
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        _royalty(receiver, bps);
    }

    function _royalty(address receiver, uint96 bps) private {
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (bps == 0) _deleteDefaultRoyalty();
        else _setDefaultRoyalty(receiver, bps);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981, IERC165) returns (bool) {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }
}
