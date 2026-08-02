import * as React from 'react';
import renderer, { act } from 'react-test-renderer';

import { MonoText } from '../StyledText';

it(`renders correctly`, () => {
  let component;

  act(() => {
    component = renderer.create(<MonoText>Snapshot test!</MonoText>);
  });

  const tree = component.toJSON();

  expect(tree).not.toBeNull();
  expect(tree).toMatchSnapshot();
});
