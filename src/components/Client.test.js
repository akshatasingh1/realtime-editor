import { render, screen } from '@testing-library/react';
import Client from './Client';

test('renders the username', () => {
    render(<Client username="john doe" />);
    expect(screen.getByText('john doe')).toBeInTheDocument();
});

test('renders a client entry with an avatar', () => {
    const { container } = render(<Client username="Ada Lovelace" />);
    expect(container.querySelector('.client')).toBeInTheDocument();
    expect(container.querySelector('.username')).toHaveTextContent('Ada Lovelace');
});
